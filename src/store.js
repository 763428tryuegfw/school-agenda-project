// Camada de dados (SQLite). Toda consulta usa parâmetros (?), nunca concatenação de texto do usuário.
// Recebe `sql` (SqlStorage do Durable Object, ou o simulador de teste em Node) e `tx` (transação síncrona).
// Todo método é síncrono => cada chamada é atômica dentro do Durable Object.
import { localNow } from '../public/digest.js';
import { LIMITS } from './validate.js';
import { CHUNK_BYTES } from './files.js';

const IDLE_MS = 14 * 864e5;      // sessão expira após 14 dias sem uso
const ABSOLUTE_MS = 60 * 864e5;  // e no máximo 60 dias depois do login
const TOUCH_MS = 10 * 60e3;      // só regrava "último uso" a cada 10 min
const AUDIT_KEEP_MS = 90 * 864e5;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, terms_version TEXT NOT NULL, terms_at INTEGER NOT NULL,
    totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0,
    tz TEXT NOT NULL DEFAULT 'America/Sao_Paulo', notif_enabled INTEGER NOT NULL DEFAULT 0, notif_hour INTEGER NOT NULL DEFAULT 7,
    last_digest_day TEXT, rev INTEGER NOT NULL DEFAULT 0, pw_changed_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS recovery_codes(
    user_id TEXT NOT NULL, code_hash TEXT NOT NULL, used_at INTEGER, PRIMARY KEY(user_id, code_hash))`,
  `CREATE TABLE IF NOT EXISTS sessions(
    id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, ip_hash TEXT, ua TEXT)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS reset_tokens(
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS items(
    user_id TEXT NOT NULL, id TEXT NOT NULL, titulo TEXT NOT NULL, materia TEXT NOT NULL, tipo TEXT NOT NULL,
    data TEXT NOT NULL, obs TEXT NOT NULL DEFAULT '', feita INTEGER NOT NULL DEFAULT 0, feita_em TEXT, comp TEXT,
    updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, id))`,
  `CREATE TABLE IF NOT EXISTS materias(
    user_id TEXT NOT NULL, id TEXT NOT NULL, nome TEXT NOT NULL, comps TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, id))`,
  `CREATE TABLE IF NOT EXISTS push_subs(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    created_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS push_user ON push_subs(user_id)`,
  // Arquivos enviados: metadados em `files`; o conteúdo em pedaços de 1 MB em `file_chunks` (nome interno = id aleatório).
  `CREATE TABLE IF NOT EXISTS files(
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, item_id TEXT, materia TEXT NOT NULL,
    name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, inline INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, chunks INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS files_user ON files(user_id)`,
  `CREATE INDEX IF NOT EXISTS files_item ON files(user_id, item_id)`,
  `CREATE TABLE IF NOT EXISTS file_chunks(
    file_id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(file_id, seq))`,
  `CREATE TABLE IF NOT EXISTS rate_limits(
    key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, event TEXT NOT NULL, ip_hash TEXT, detail TEXT)`,
];

export class Store {
  constructor(sql, tx) {
    this.sql = sql;
    this.tx = tx;
  }

  q(query, ...p) { return this.sql.exec(query, ...p).toArray(); }
  one(query, ...p) { const r = this.q(query, ...p); return r.length ? r[0] : null; }
  run(query, ...p) { this.sql.exec(query, ...p).toArray(); }

  migrate() { for (const s of SCHEMA) this.run(s); }

  // ---------- Usuários ----------
  getUserByEmail(email) { return this.one('SELECT * FROM users WHERE email = ?', email); }
  getUserById(id) { return this.one('SELECT * FROM users WHERE id = ?', id); }

  createUser({ id, email, pwHash, termsVersion, now, recoveryHashes }) {
    return this.tx(() => {
      if (this.one('SELECT 1 AS x FROM users WHERE email = ?', email)) return { error: 'exists' };
      this.run('INSERT INTO users(id,email,pw_hash,created_at,terms_version,terms_at,pw_changed_at) VALUES(?,?,?,?,?,?,?)',
        id, email, pwHash, now, termsVersion, now, now);
      for (const h of recoveryHashes) this.run('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)', id, h);
      return { ok: true };
    });
  }

  setPassword(userId, pwHash, now) {
    this.run('UPDATE users SET pw_hash = ?, pw_changed_at = ? WHERE id = ?', pwHash, now, userId);
  }

  // ---------- Sessões ----------
  createSession({ idHash, userId, now, ipHash, ua }) {
    this.run('INSERT INTO sessions(id_hash,user_id,created_at,last_seen,expires_at,ip_hash,ua) VALUES(?,?,?,?,?,?,?)',
      idHash, userId, now, now, now + ABSOLUTE_MS, ipHash, String(ua || '').slice(0, 120));
    // limita a 20 sessões por conta (remove as mais antigas)
    this.run(`DELETE FROM sessions WHERE user_id = ? AND id_hash NOT IN
      (SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20)`, userId, userId);
  }

  getSession(idHash, now) {
    const s = this.one('SELECT * FROM sessions WHERE id_hash = ?', idHash);
    if (!s) return null;
    if (s.expires_at <= now || now - s.last_seen > IDLE_MS) { this.run('DELETE FROM sessions WHERE id_hash = ?', idHash); return null; }
    const u = this.one('SELECT id,email,totp_enabled,tz,notif_enabled,notif_hour,created_at FROM users WHERE id = ?', s.user_id);
    if (!u) { this.run('DELETE FROM sessions WHERE id_hash = ?', idHash); return null; }
    if (now - s.last_seen > TOUCH_MS) this.run('UPDATE sessions SET last_seen = ? WHERE id_hash = ?', now, idHash);
    return { user: u, session: { created_at: s.created_at } };
  }

  deleteSession(idHash) { this.run('DELETE FROM sessions WHERE id_hash = ?', idHash); }

  /** Encerra todas as sessões da conta (menos a indicada, se houver). */
  deleteUserSessions(userId, exceptIdHash) {
    if (exceptIdHash) this.run('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?', userId, exceptIdHash);
    else this.run('DELETE FROM sessions WHERE user_id = ?', userId);
  }

  listSessions(userId, currentIdHash) {
    return this.q('SELECT id_hash,created_at,last_seen,ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', userId)
      .map((s) => ({ current: s.id_hash === currentIdHash, created_at: s.created_at, last_seen: s.last_seen, ua: s.ua }));
  }

  knownIp(userId, ipHash) {
    return !!this.one('SELECT 1 AS x FROM sessions WHERE user_id = ? AND ip_hash = ? LIMIT 1', userId, ipHash);
  }

  // ---------- Limites de uso ----------
  /** Conta uma ocorrência. Devolve {allowed, retryAfter}. */
  rateHit(key, limit, windowSec, now) {
    return this.tx(() => {
      const r = this.one('SELECT * FROM rate_limits WHERE key = ?', key);
      let count, start, blocked = 0;
      if (!r || now - r.window_start >= windowSec * 1000) { count = 1; start = now; blocked = r ? r.blocked_until : 0; }
      else { count = r.count + 1; start = r.window_start; blocked = r.blocked_until; }
      this.run('INSERT INTO rate_limits(key,count,window_start,blocked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, window_start=excluded.window_start',
        key, count, start, blocked);
      if (blocked > now) return { allowed: false, retryAfter: Math.ceil((blocked - now) / 1000) };
      if (count > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((start + windowSec * 1000 - now) / 1000)) };
      return { allowed: true, retryAfter: 0 };
    });
  }

  /** Só consulta (não conta). */
  rateCheck(key, limit, windowSec, now) {
    const r = this.one('SELECT * FROM rate_limits WHERE key = ?', key);
    if (!r) return { allowed: true, retryAfter: 0 };
    if (r.blocked_until > now) return { allowed: false, retryAfter: Math.ceil((r.blocked_until - now) / 1000) };
    if (now - r.window_start < windowSec * 1000 && r.count >= limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((r.window_start + windowSec * 1000 - now) / 1000)) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  /** Registra uma falha com atraso progressivo: após `free` falhas, espera 15 s, 30 s, 60 s... até 15 min. */
  rateFail(key, free, windowSec, now) {
    return this.tx(() => {
      const r = this.one('SELECT * FROM rate_limits WHERE key = ?', key);
      let count = 1, start = now;
      if (r && now - r.window_start < windowSec * 1000) { count = r.count + 1; start = r.window_start; }
      let blocked = 0;
      if (count > free) blocked = now + Math.min(15 * 2 ** (count - free - 1), 900) * 1000;
      this.run(`INSERT INTO rate_limits(key,count,window_start,blocked_until) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET count=excluded.count, window_start=excluded.window_start, blocked_until=excluded.blocked_until`,
        key, count, start, blocked);
      return { count, retryAfter: blocked > now ? Math.ceil((blocked - now) / 1000) : 0 };
    });
  }

  rateReset(key) { this.run('DELETE FROM rate_limits WHERE key = ?', key); }
  /** Devolve uma reserva feita por rateHit (usado quando a tentativa deu certo). */
  rateRefund(key) { this.run('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0', key); }

  // ---------- Auditoria (sem senhas, sem e-mails, IP só em forma de hash) ----------
  audit(event, { userId = null, ipHash = null, detail = null, now }) {
    this.run('INSERT INTO audit(ts,user_id,event,ip_hash,detail) VALUES(?,?,?,?,?)', now, userId, event, ipHash, detail ? String(detail).slice(0, 200) : null);
  }

  recentAudit(limit = 50) { return this.q('SELECT ts,user_id,event,ip_hash,detail FROM audit ORDER BY id DESC LIMIT ?', limit); }

  purge(now) {
    this.run('DELETE FROM audit WHERE ts < ?', now - AUDIT_KEEP_MS);
    this.run('DELETE FROM sessions WHERE expires_at <= ? OR last_seen < ?', now, now - IDLE_MS);
    this.run('DELETE FROM reset_tokens WHERE expires_at <= ?', now - 864e5);
    this.run('DELETE FROM rate_limits WHERE blocked_until < ? AND window_start < ?', now, now - 2 * 864e5);
  }

  // ---------- Códigos de recuperação e redefinição ----------
  /** Consome um código de recuperação (uso único). */
  useRecoveryCode(userId, codeHash, now) {
    return this.tx(() => {
      const r = this.one('SELECT used_at FROM recovery_codes WHERE user_id = ? AND code_hash = ?', userId, codeHash);
      if (!r || r.used_at) return false;
      this.run('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ?', now, userId, codeHash);
      return true;
    });
  }

  replaceRecoveryCodes(userId, hashes) {
    this.tx(() => {
      this.run('DELETE FROM recovery_codes WHERE user_id = ?', userId);
      for (const h of hashes) this.run('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)', userId, h);
    });
  }

  recoveryCodesLeft(userId) { return this.one('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL', userId).n; }

  createResetToken(userId, tokenHash, expiresAt) {
    this.tx(() => {
      this.run('DELETE FROM reset_tokens WHERE user_id = ?', userId);   // só o link mais recente vale
      this.run('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)', tokenHash, userId, expiresAt);
    });
  }

  /** Consulta sem consumir. */
  peekResetToken(tokenHash, now) {
    const r = this.one('SELECT user_id,expires_at,used_at FROM reset_tokens WHERE token_hash = ?', tokenHash);
    return r && !r.used_at && r.expires_at > now ? r.user_id : null;
  }

  /** Uso único: devolve o id do usuário e marca como usado, ou null. */
  consumeResetToken(tokenHash, now) {
    return this.tx(() => {
      const r = this.one('SELECT * FROM reset_tokens WHERE token_hash = ?', tokenHash);
      if (!r || r.used_at || r.expires_at <= now) return null;
      this.run('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?', now, tokenHash);
      return r.user_id;
    });
  }

  // ---------- Verificação em duas etapas ----------
  setTotpPending(userId, sealed) { this.run('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_last_step = 0 WHERE id = ?', sealed, userId); }
  enableTotp(userId) { this.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', userId); }
  disableTotp(userId) { this.run('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_last_step = 0 WHERE id = ?', userId); }
  /** Impede reutilizar o mesmo código: só aceita passos maiores que o último usado. */
  totpMarkUsed(userId, step) {
    return this.tx(() => {
      const u = this.one('SELECT totp_last_step FROM users WHERE id = ?', userId);
      if (!u || step <= u.totp_last_step) return false;
      this.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, userId);
      return true;
    });
  }

  // ---------- Dados da agenda (sempre filtrados por user_id) ----------
  getState(userId) {
    const items = this.q('SELECT id,titulo,materia,tipo,data,obs,feita,feita_em,comp FROM items WHERE user_id = ? ORDER BY data, id', userId)
      .map((r) => {
        const o = { id: r.id, titulo: r.titulo, materia: r.materia, tipo: r.tipo, data: r.data, obs: r.obs, feita: !!r.feita };
        if (r.feita) o.feitaEm = r.feita_em || r.data;
        if (r.comp) o.comp = r.comp;
        return o;
      });
    const materias = this.q('SELECT id,nome,comps FROM materias WHERE user_id = ? ORDER BY nome, id', userId)
      .map((r) => ({ id: r.id, nome: r.nome, comps: JSON.parse(r.comps) }));
    const u = this.one('SELECT rev FROM users WHERE id = ?', userId);
    return { items, materias, rev: u ? u.rev : 0 };
  }

  /** Aplica um lote (já validado). Tudo ou nada; respeita os limites por conta. */
  applySync(userId, ops, now) {
    return this.tx(() => {
      for (const it of ops.items.upsert) {
        this.run(`INSERT INTO items(user_id,id,titulo,materia,tipo,data,obs,feita,feita_em,comp,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,id) DO UPDATE SET titulo=excluded.titulo, materia=excluded.materia, tipo=excluded.tipo, data=excluded.data,
          obs=excluded.obs, feita=excluded.feita, feita_em=excluded.feita_em, comp=excluded.comp, updated_at=excluded.updated_at`,
          userId, it.id, it.titulo, it.materia, it.tipo, it.data, it.obs, it.feita ? 1 : 0, it.feitaEm, it.comp, now);
      }
      for (const id of ops.items.delete) {
        this.run('DELETE FROM items WHERE user_id = ? AND id = ?', userId, id);
        // Os arquivos da atividade apagada não somem: passam a ser anexos da matéria (o usuário apaga arquivos só ao pedir).
        this.run("UPDATE files SET scope = 'materia', item_id = NULL WHERE user_id = ? AND item_id = ?", userId, id);
      }
      for (const m of ops.materias.upsert) {
        this.run(`INSERT INTO materias(user_id,id,nome,comps,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(user_id,id) DO UPDATE SET nome=excluded.nome, comps=excluded.comps, updated_at=excluded.updated_at`,
          userId, m.id, m.nome, JSON.stringify(m.comps), now);
      }
      for (const id of ops.materias.delete) this.run('DELETE FROM materias WHERE user_id = ? AND id = ?', userId, id);
      const ni = this.one('SELECT COUNT(*) AS n FROM items WHERE user_id = ?', userId).n;
      const nm = this.one('SELECT COUNT(*) AS n FROM materias WHERE user_id = ?', userId).n;
      if (ni > LIMITS.items || nm > LIMITS.materias) throw new Error('limit_exceeded');   // desfaz o lote inteiro
      this.run('UPDATE users SET rev = rev + 1 WHERE id = ?', userId);
      return this.one('SELECT rev FROM users WHERE id = ?', userId).rev;
    });
  }

  // ---------- Notificações ----------
  setNotifPrefs(userId, { enabled, hour, tz }) {
    if (enabled !== undefined) this.run('UPDATE users SET notif_enabled = ? WHERE id = ?', enabled ? 1 : 0, userId);
    if (hour !== undefined) this.run('UPDATE users SET notif_hour = ? WHERE id = ?', hour, userId);
    if (tz !== undefined) this.run('UPDATE users SET tz = ? WHERE id = ?', tz, userId);
  }

  addPushSub(userId, { id, endpoint, p256dh, auth }, now) {
    return this.tx(() => {
      const n = this.one('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', userId).n;
      const existing = this.one('SELECT user_id FROM push_subs WHERE endpoint = ?', endpoint);
      if (!existing && n >= 10) return { error: 'too_many' };
      // O mesmo aparelho pode trocar de conta: o endpoint passa a pertencer à conta atual
      this.run(`INSERT INTO push_subs(id,user_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, fail_count=0`,
        id, userId, endpoint, p256dh, auth, now);
      return { ok: true };
    });
  }

  listPushSubs(userId) { return this.q('SELECT id,endpoint,p256dh,auth FROM push_subs WHERE user_id = ?', userId); }
  removePushSub(userId, endpoint) { this.run('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?', userId, endpoint); }
  countPushSubs(userId) { return this.one('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', userId).n; }
  deletePushSubById(id) { this.run('DELETE FROM push_subs WHERE id = ?', id); }
  bumpPushFail(id, max = 5) {
    this.run('UPDATE push_subs SET fail_count = fail_count + 1 WHERE id = ?', id);
    this.run('DELETE FROM push_subs WHERE id = ? AND fail_count >= ?', id, max);
  }
  resetPushFail(id) { this.run('UPDATE push_subs SET fail_count = 0 WHERE id = ? AND fail_count <> 0', id); }

  /** Usuários cujo aviso diário está pendente agora (hora local >= hora escolhida e ainda não enviado hoje). */
  dueDigests(nowMs, limit) {
    const users = this.q(`SELECT id,tz,notif_hour,last_digest_day FROM users WHERE notif_enabled = 1
      AND EXISTS(SELECT 1 FROM push_subs p WHERE p.user_id = users.id)`);
    const out = [];
    for (const u of users) {
      let ln;
      try { ln = localNow(u.tz, nowMs); } catch { continue; }
      if (ln.hour < u.notif_hour || u.last_digest_day === ln.day) continue;
      const state = this.getState(u.id);
      const subs = this.q('SELECT id,endpoint,p256dh,auth FROM push_subs WHERE user_id = ?', u.id);
      out.push({ userId: u.id, today: ln.day, items: state.items, subs });
      if (out.length >= limit) break;
    }
    return out;
  }

  markDigestSent(userId, day) { this.run('UPDATE users SET last_digest_day = ? WHERE id = ?', day, userId); }

  // ---------- Arquivos enviados ----------
  fileView(r) { return { id: r.id, scope: r.scope, itemId: r.item_id, materia: r.materia, name: r.name, kind: r.kind, mime: r.mime, inline: !!r.inline, size: r.size, createdAt: r.created_at }; }
  fileUsage(userId) { const r = this.one('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM files WHERE user_id = ?', userId); return { count: r.n, bytes: r.b }; }

  /** Guarda um arquivo já validado pelo Worker. `bytes` é um ArrayBuffer. Tudo-ou-nada (transação). */
  addFile(userId, meta, bytes, limits, now) {
    return this.tx(() => {
      let materia = meta.materia, itemId = null, scope = 'materia';
      if (meta.scope === 'item') {
        // A matéria vem da atividade que está no servidor (e que precisa ser DESTE usuário), nunca do que o navegador disser.
        const it = this.one('SELECT materia FROM items WHERE user_id = ? AND id = ?', userId, meta.itemId);
        if (!it) return { error: 'item_not_found' };
        if (this.one('SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND item_id = ?', userId, meta.itemId).n >= limits.maxItemFiles) return { error: 'too_many_item_files' };
        scope = 'item'; itemId = meta.itemId; materia = it.materia;
      }
      const use = this.fileUsage(userId);
      if (use.count >= limits.maxFiles) return { error: 'too_many_files' };
      if (use.bytes + bytes.byteLength > limits.accountBytes) return { error: 'quota_exceeded' };
      const n = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
      this.run('INSERT INTO files(id,user_id,scope,item_id,materia,name,kind,mime,inline,size,sha256,chunks,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        meta.id, userId, scope, itemId, materia, meta.name, meta.kind, meta.mime, meta.inline ? 1 : 0, bytes.byteLength, meta.sha256, n, now);
      for (let i = 0; i < n; i++) this.run('INSERT INTO file_chunks(file_id,seq,data) VALUES(?,?,?)', meta.id, i, bytes.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
      return { ok: true, file: this.fileView(this.one('SELECT * FROM files WHERE id = ?', meta.id)) };
    });
  }

  listFiles(userId) {
    return { files: this.q('SELECT * FROM files WHERE user_id = ? ORDER BY created_at DESC, id', userId).map((r) => this.fileView(r)), usage: this.fileUsage(userId) };
  }

  /** Metadados de UM arquivo, somente se pertencer ao usuário (senão null: o servidor responde "não encontrado"). */
  getFile(userId, id) {
    const r = this.one('SELECT * FROM files WHERE user_id = ? AND id = ?', userId, id);
    return r ? this.fileView(r) : null;
  }

  /** Lê os bytes [start, end] (inclusive) de um arquivo do usuário. Devolve um ArrayBuffer ou null. */
  readFileRange(userId, id, start, end) {
    const f = this.one('SELECT size, chunks FROM files WHERE user_id = ? AND id = ?', userId, id);
    if (!f || start < 0 || end >= f.size || end < start) return null;
    const first = Math.floor(start / CHUNK_BYTES), last = Math.floor(end / CHUNK_BYTES);
    const out = new Uint8Array(end - start + 1);
    const rows = this.q('SELECT seq, data FROM file_chunks WHERE file_id = ? AND seq BETWEEN ? AND ? ORDER BY seq', id, first, last);
    if (rows.length !== last - first + 1) return null;
    for (const row of rows) {
      const d = new Uint8Array(row.data), base = row.seq * CHUNK_BYTES;
      const from = Math.max(start, base), to = Math.min(end, base + d.length - 1);
      out.set(d.subarray(from - base, to - base + 1), from - start);
    }
    return out.buffer;
  }

  deleteFile(userId, id) {
    return this.tx(() => {
      if (!this.one('SELECT 1 AS x FROM files WHERE user_id = ? AND id = ?', userId, id)) return false;
      this.run('DELETE FROM file_chunks WHERE file_id = ?', id);
      this.run('DELETE FROM files WHERE user_id = ? AND id = ?', userId, id);
      return true;
    });
  }

  // ---------- LGPD: exportar e excluir ----------
  exportUser(userId) {
    const u = this.one('SELECT id,email,created_at,terms_version,terms_at,tz,notif_enabled,notif_hour,totp_enabled FROM users WHERE id = ?', userId);
    if (!u) return null;
    const st = this.getState(userId);
    return {
      conta: { id: u.id, email: u.email, criada_em: new Date(u.created_at).toISOString(), termos_versao: u.terms_version,
        termos_aceitos_em: new Date(u.terms_at).toISOString(), fuso: u.tz, avisos_ativos: !!u.notif_enabled,
        hora_do_aviso: u.notif_hour, verificacao_em_duas_etapas: !!u.totp_enabled },
      atividades: st.items,
      materias: st.materias,
      arquivos_enviados: this.q('SELECT name, kind, size, materia, item_id, created_at FROM files WHERE user_id = ? ORDER BY created_at', userId)
        .map((f) => ({ nome: f.name, tipo: f.kind, tamanho_bytes: f.size, materia: f.materia, atividade_id: f.item_id, enviado_em: new Date(f.created_at).toISOString() })),
      aparelhos_com_aviso: this.countPushSubs(userId),
      sessoes_ativas: this.q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', userId)[0].n,
    };
  }

  deleteUser(userId) {
    this.tx(() => {
      this.run('DELETE FROM file_chunks WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', userId);
      for (const t of ['files', 'items', 'materias', 'sessions', 'push_subs', 'recovery_codes', 'reset_tokens']) {
        this.run(`DELETE FROM ${t} WHERE user_id = ?`, userId);   // nome da tabela vem de lista fixa acima
      }
      this.run('UPDATE audit SET user_id = NULL WHERE user_id = ?', userId);
      this.run('DELETE FROM users WHERE id = ?', userId);
    });
  }
}
