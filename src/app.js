// Rotas da API, cabeçalhos de segurança e tarefa agendada. Toda decisão de identidade e permissão é tomada AQUI,
// a partir do cookie de sessão — nunca a partir do que o navegador diz sobre quem ele é.
import { b64uEncode, randomToken, randomBytes, sha256Hex, hmacSha256, hex, utf8 } from './util.js';
import { hashPassword, verifyPassword, dummyVerify, checkPasswordPolicy } from './passwords.js';
import { newTotpSecret, verifyTotp, totpStep, otpauthUri, sealSecret, openSecret } from './totp.js';
import { sendWebPush, vapidConfigured } from './webpush.js';
import { sendResetEmail, mailConfigured } from './mail.js';
import { ValidationError, normalizeEmail, validateSyncBody, validatePrefs, validatePushSub, validateMateriaName, isValidId, LIMITS } from './validate.js';
import { fileLimits, detectFile, safeName, extOf, contentDisposition, parseRange } from './files.js';
import { validTimeZone, buildDigest, digestMessage } from '../public/digest.js';

export const TERMS_VERSION = '2026-10-23';
const COOKIE = '__Host-sid';
const SESSION_MAX_AGE = 60 * 86400;
const RESET_TTL_MS = 30 * 60e3;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sem 0/O/1/I para não confundir ao digitar

class HttpError extends Error {
  constructor(status, code, headers) { super(code); this.status = status; this.code = code; this.headers = headers; }
}
const fail = (status, code, headers) => { throw new HttpError(status, code, headers); };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

// ---------------------------------------------------------------- cabeçalhos de segurança
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export function withSecurityHeaders(res, { api }) {
  const r = new Response(res.body, res);
  const h = r.headers;
  if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', CSP);
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (api) { h.set('Cache-Control', 'no-store'); h.set('Pragma', 'no-cache'); }
  return r;
}

// ---------------------------------------------------------------- utilidades de requisição
const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Proteção CSRF: pedidos que alteram dados só valem se vierem da própria página do site. */
function checkOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) { if (origin !== url.origin) fail(403, 'forbidden_origin'); return; }
  if (request.headers.get('Sec-Fetch-Site') === 'same-origin') return;
  fail(403, 'forbidden_origin');
}

async function readJson(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.toLowerCase().startsWith('application/json')) fail(415, 'unsupported_media_type');
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > LIMITS.bodyBytes) fail(413, 'payload_too_large');
  const text = await request.text();
  if (text.length > LIMITS.bodyBytes) fail(413, 'payload_too_large');
  try { const v = JSON.parse(text); if (v === null || typeof v !== 'object') fail(400, 'invalid_json'); return v; }
  catch (e) { if (e instanceof HttpError) throw e; fail(400, 'invalid_json'); }
}

/** Lê o corpo binário de um envio de arquivo: exige Content-Length, respeita o limite e confere o tamanho recebido. */
async function readBinary(request, max) {
  const ct = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/octet-stream') fail(415, 'unsupported_media_type');
  const lenH = request.headers.get('Content-Length');
  if (lenH === null || !/^\d{1,12}$/.test(lenH)) fail(411, 'length_required');
  const len = Number(lenH);
  if (len === 0) fail(400, 'empty_file');
  if (len > max) fail(413, 'file_too_large');
  if (!request.body) fail(400, 'empty_file');
  const out = new Uint8Array(len);
  const reader = request.body.getReader();
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (off + value.length > len) { await reader.cancel().catch(() => {}); fail(400, 'length_mismatch'); }
    out.set(value, off); off += value.length;
  }
  if (off !== len) fail(400, 'length_mismatch');
  return out;
}

const headerText = (request, name, max) => {
  const raw = request.headers.get(name);
  if (raw === null) return '';
  let v;
  try { v = decodeURIComponent(raw); } catch { fail(400, 'invalid_header'); }
  if (v.length > max) fail(400, 'invalid_header');
  return v;
};

/** /api/files (enviar e listar) e /api/files/:id (abrir, baixar, apagar). Só o dono tem acesso; qualquer outro recebe 404. */
async function filesRoute(c, request, env, method, id, now) {
  const { user } = await c.auth();
  const lim = fileLimits(env);
  if (!id) {
    if (method === 'GET') { await c.limit('files:user:' + user.id, 600, 600); return json({ ...(await c.db.listFiles(user.id)), limits: lim }); }
    if (method !== 'POST') fail(405, 'method_not_allowed', { Allow: 'GET, POST' });
    await c.limit('fileup:user:' + user.id, 60, 3600);
    const scope = request.headers.get('X-Scope');
    if (scope !== 'item' && scope !== 'materia') fail(400, 'invalid_scope');
    let itemId = null, materia = null;
    if (scope === 'item') { itemId = headerText(request, 'X-Item-Id', 40); if (!isValidId(itemId)) fail(400, 'invalid_id'); }
    else materia = validateMateriaName(headerText(request, 'X-Materia', 120));
    const rawName = headerText(request, 'X-File-Name', 300);
    if (!rawName.trim()) fail(400, 'invalid_name');
    const bytes = await readBinary(request, lim.maxFileBytes);
    const det = detectFile(bytes, rawName);          // o tipo vem do CONTEÚDO; o navegador pode mentir sobre nome e tipo
    if (!det) fail(415, 'unsupported_file_type');
    let name = safeName(rawName, det.ext);
    if (extOf(name) !== det.ext) name += '.' + det.ext;
    const meta = { id: randomToken(16), scope, itemId, materia, name, kind: det.kind, mime: det.mime, inline: det.inline, size: bytes.length, sha256: await sha256Hex(bytes) };
    const r = await c.db.addFile(user.id, meta, bytes.buffer, lim, now);
    if (r.error) {
      const map = { item_not_found: 404, too_many_item_files: 422, too_many_files: 422, quota_exceeded: 422 };
      fail(map[r.error] || 400, r.error);
    }
    await c.audit('file_upload', { userId: user.id, detail: det.kind });
    return json({ file: r.file }, 201);
  }
  if (method === 'DELETE') {
    if (!(await c.db.deleteFile(user.id, id))) fail(404, 'not_found');
    await c.audit('file_delete', { userId: user.id });
    return json({ ok: true });
  }
  if (method !== 'GET') fail(405, 'method_not_allowed', { Allow: 'GET, DELETE' });
  await c.limit('files:user:' + user.id, 600, 600);
  const f = await c.db.getFile(user.id, id);
  if (!f) fail(404, 'not_found');
  const range = parseRange(request.headers.get('Range'), f.size);
  if (range === 'invalid') fail(416, 'range_not_satisfiable', { 'Content-Range': `bytes */${f.size}` });
  const start = range ? range.start : 0, end = range ? range.end : f.size - 1;
  const data = await c.db.readFileRange(user.id, id, start, end);
  if (!data) fail(500, 'internal');
  const inline = f.inline && c.url.searchParams.get('download') !== '1';
  return new Response(data, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': f.mime,
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', f.name),
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${f.size}` } : {}),
      'Cache-Control': 'private, no-store',
      // Arquivo do usuário nunca roda scripts nem carrega nada, mesmo se alguém o abrir direto no navegador.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}

function deviceLabel(ua) {
  ua = String(ua || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

function newRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const b = randomBytes(12);
    let s = '';
    for (let k = 0; k < 12; k++) s += CODE_ALPHABET[b[k] & 31];
    codes.push(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`);
  }
  return codes;
}
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------------------------------------------------------------- contexto
/** Endereços IPv6 de uma casa/escola costumam ter um bloco /64 inteiro: o limite vale para o bloco, não para cada endereço. */
export function ipKey(ip) {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  if (!ip.includes('::')) return h.slice(0, 4).join(':').toLowerCase();
  return [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':').toLowerCase();
}

function makeCtx(request, env, deps, now, url) {
  const cfg = {
    pepper: env.PEPPER,
    db: () => env.DB.get(env.DB.idFromName('main')),
  };
  // Falha fechada: sem um PEPPER de verdade (ou com o texto de exemplo do repositório) a API não funciona.
  if (!cfg.pepper || String(cfg.pepper).length < 32 || /troque-por|exemplo|changeme|cole-aqui/i.test(String(cfg.pepper))) fail(503, 'server_misconfigured');
  const db = cfg.db();
  const ip = ipKey(request.headers.get('CF-Connecting-IP') || 'unknown');
  const ctx = {
    request, env, deps, now, url, db,
    pepper: cfg.pepper,
    ipHash: null, userAgent: request.headers.get('User-Agent') || '',
    async init() { this.ipHash = (await hmacHex(cfg.pepper, 'ip:' + ip)).slice(0, 24); return this; },
    async limit(key, limit, windowSec) {
      const r = await db.rateHit(key, limit, windowSec, now);
      if (!r.allowed) {
        await db.audit('rate_limited', { ipHash: this.ipHash, detail: key.split(':')[0], now });
        fail(429, 'rate_limited', { 'Retry-After': String(r.retryAfter) });
      }
    },
    async audit(event, extra = {}) { await db.audit(event, { ipHash: this.ipHash, now, ...extra }); },
    async auth() {
      const token = getCookie(request, COOKIE);
      if (!token || !TOKEN_RE.test(token)) fail(401, 'unauthenticated');
      const idHash = await sha256Hex(token);
      const s = await db.getSession(idHash, now);
      if (!s) fail(401, 'unauthenticated', { 'Set-Cookie': cookieHeader('', 0) });
      return { user: s.user, idHash };
    },
    async startSession(userId) {
      const token = randomToken(32);
      await db.createSession({ idHash: await sha256Hex(token), userId, now, ipHash: this.ipHash, ua: deviceLabel(this.userAgent) });
      return cookieHeader(token, SESSION_MAX_AGE);
    },
  };
  return ctx;
}

async function hmacHex(secret, data) { return hex(await hmacSha256(utf8(secret), data)); }
const recoveryHash = async (pepper, code) => hmacHex(pepper, 'rc:' + normCode(code));

const publicUser = (u) => ({
  email: u.email,
  createdAt: u.created_at,
  totp: !!u.totp_enabled,
  notif: { enabled: !!u.notif_enabled, hour: u.notif_hour, tz: u.tz },
});

function passwordError(code) {
  const map = { too_short: 'password_too_short', too_long: 'password_too_long', too_common: 'password_too_common', same_as_email: 'password_same_as_email', invalid: 'invalid_password' };
  fail(400, map[code] || 'invalid_password');
}

async function checkSecondFactor(c, user, code) {
  if (!user.totp_enabled) return true;
  if (!code) return false;
  const secret = await openSecret(user.totp_secret, c.pepper);
  const step = await verifyTotp(secret, code, c.now);
  if (step === null) return false;
  return await c.db.totpMarkUsed(user.id, step);
}

async function requirePasswordAndFactor(c, user, body) {
  const full = await c.db.getUserById(user.id);
  const pw = typeof body.password === 'string' ? body.password : '';
  const v = await verifyPassword(pw, full.pw_hash, c.pepper);
  if (!v.ok) { await c.audit('reauth_fail', { userId: user.id }); fail(403, 'wrong_password'); }
  if (full.totp_enabled && !(await checkSecondFactor(c, full, body.code))) fail(403, 'invalid_code');
  return full;
}

// ---------------------------------------------------------------- rotas
async function api(request, url, env, deps, now) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;

  if (path === '/api/health') return json({ ok: true });

  if (path === '/api/config') {
    if (method !== 'GET') fail(405, 'method_not_allowed', { Allow: 'GET' });
    return json({
      registrationOpen: env.REGISTRATION_OPEN !== 'false',
      mailReset: mailConfigured(env),
      vapidPublicKey: vapidConfigured(env) ? env.VAPID_PUBLIC : null,
      termsVersion: TERMS_VERSION,
      contactEmail: env.CONTACT_EMAIL || null,
      controllerName: env.CONTROLLER_NAME || null,
    });
  }

  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(method)) fail(405, 'method_not_allowed');
  if (method !== 'GET' && method !== 'HEAD') checkOrigin(request, url);

  const c = await makeCtx(request, env, deps, now, url).init();
  await c.limit('api:' + c.ipHash, 1500, 600);          // teto geral por origem

  const fm = /^\/api\/files(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(path);
  if (fm) return filesRoute(c, request, env, method, fm[1] || null, now);

  const route = `${method} ${path}`;
  switch (route) {
    // ------------------------------------------------------------ cadastro e entrada
    case 'POST /api/auth/register': {
      if (env.REGISTRATION_OPEN === 'false') fail(403, 'registration_closed');
      await c.limit('reg:ip:' + c.ipHash, 6, 3600);
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      if (body.acceptTerms !== true) fail(400, 'terms_required');
      if (body.confirmAge !== true) fail(400, 'age_required');      // declaração de idade (ver Termos de Uso)
      if (typeof body.password !== 'string') fail(400, 'invalid_password');
      const pe = checkPasswordPolicy(body.password, email);
      if (pe) passwordError(pe);
      await c.limit('reg:all', 400, 86400);          // só pedidos válidos gastam o teto global
      const pwHash = await hashPassword(body.password, c.pepper);
      const codes = newRecoveryCodes();
      const id = randomToken(16);
      const r = await c.db.createUser({
        id, email, pwHash, termsVersion: TERMS_VERSION, now,
        recoveryHashes: await Promise.all(codes.map((x) => recoveryHash(c.pepper, x))),
      });
      if (r.error) { await c.audit('register_duplicate'); fail(409, 'account_unavailable'); }
      await c.audit('register', { userId: id });
      const cookie = await c.startSession(id);
      return json({ user: { email, createdAt: now, totp: false, notif: { enabled: false, hour: 7, tz: 'America/Sao_Paulo' } }, recoveryCodes: codes }, 201, { 'Set-Cookie': cookie });
    }

    case 'POST /api/auth/login': {
      await c.limit('login:ip:' + c.ipHash, 60, 900);
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
      const emailKey = (await sha256Hex('em:' + email)).slice(0, 24);
      const pairKey = `login:pair:${c.ipHash}:${emailKey}`;
      const mailFailKey = `login:email:${emailKey}`;
      const user = await c.db.getUserByEmail(email);

      const pair = await c.db.rateCheck(pairKey, 1e9, 3600, now);   // só vale o atraso progressivo (rateFail)
      if (!pair.allowed) fail(429, 'rate_limited', { 'Retry-After': String(pair.retryAfter) });
      // Contra tentativas espalhadas por vários IPs: acima do limite da conta só passam aparelhos que já entraram
      // nessa conta antes. Assim um invasor não consegue trancar o dono para fora só errando a senha de propósito.
      // A tentativa é RESERVADA (contada) antes de verificar a senha: assim pedidos simultâneos não passam todos
      // pelo mesmo contador ainda zerado. Se a senha estiver certa, a reserva é devolvida.
      const acct = await c.db.rateHit(mailFailKey, 40, 3600, now);
      if (!acct.allowed && !(user && (await c.db.knownIp(user.id, c.ipHash)))) {
        fail(429, 'rate_limited', { 'Retry-After': String(acct.retryAfter) });
      }

      let ok = false, rehash = false;
      if (user) { const v = await verifyPassword(password, user.pw_hash, c.pepper); ok = v.ok; rehash = v.needsRehash; }
      else await dummyVerify(password, c.pepper);

      if (ok && user.totp_enabled) {
        if (!body.code) return json({ error: 'mfa_required' }, 401);   // senha certa, falta o código
        if (!(await checkSecondFactor(c, user, body.code))) ok = false;
      }
      if (!ok) {
        await c.db.rateFail(pairKey, 5, 3600, now);
        await c.audit('login_fail', { userId: user ? user.id : null });
        fail(401, 'invalid_credentials');
      }
      await c.db.rateReset(pairKey);
      await c.db.rateRefund(mailFailKey);
      if (rehash) await c.db.setPassword(user.id, await hashPassword(password, c.pepper), now);
      const cookie = await c.startSession(user.id);          // sessão nova a cada login (evita fixação de sessão)
      await c.audit('login_ok', { userId: user.id });
      return json({ user: publicUser(user) }, 200, { 'Set-Cookie': cookie });
    }

    case 'POST /api/auth/logout': {
      const token = getCookie(request, COOKIE);
      if (token && TOKEN_RE.test(token)) await c.db.deleteSession(await sha256Hex(token));
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
    }

    case 'GET /api/auth/me': {
      const { user } = await c.auth();
      return json({ user: publicUser(user) });
    }

    // ------------------------------------------------------------ senha
    case 'POST /api/auth/change-password': {
      const { user, idHash } = await c.auth();
      await c.limit('pw:user:' + user.id, 10, 3600);
      const body = await readJson(request);
      if (typeof body.next !== 'string') fail(400, 'invalid_password');
      const pe = checkPasswordPolicy(body.next, user.email);
      if (pe) passwordError(pe);
      await requirePasswordAndFactor(c, user, { password: body.current, code: body.code });
      await c.db.setPassword(user.id, await hashPassword(body.next, c.pepper), now);
      await c.db.deleteUserSessions(user.id, idHash);         // derruba os outros aparelhos
      await c.audit('password_change', { userId: user.id });
      return json({ ok: true });
    }

    case 'POST /api/auth/recover': {              // redefinir senha com um código de recuperação (guardado no cadastro)
      await c.limit('rec:ip:' + c.ipHash, 10, 3600);
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      await c.limit('rec:em:' + (await sha256Hex('em:' + email)).slice(0, 24), 8, 3600);
      if (typeof body.newPassword !== 'string') fail(400, 'invalid_password');
      const pe = checkPasswordPolicy(body.newPassword, email);
      if (pe) passwordError(pe);                 // checado antes: senha fraca não gasta o código
      const user = await c.db.getUserByEmail(email);
      const newHash = await hashPassword(body.newPassword, c.pepper);
      let ok = false;
      if (user) {
        const secondOk = !user.totp_enabled || (await checkSecondFactor(c, user, body.totp));
        if (secondOk) ok = await c.db.useRecoveryCode(user.id, await recoveryHash(c.pepper, body.code), now);
      } else await recoveryHash(c.pepper, body.code);
      if (!ok) { await c.audit('recover_fail', { userId: user ? user.id : null }); fail(400, 'invalid_recovery'); }
      await c.db.setPassword(user.id, newHash, now);
      await c.db.deleteUserSessions(user.id);
      await c.audit('password_recover', { userId: user.id });
      return json({ ok: true, codesLeft: await c.db.recoveryCodesLeft(user.id) });
    }

    case 'POST /api/auth/forgot': {               // pedido de link por e-mail (só se houver provedor de e-mail configurado)
      await c.limit('fgt:ip:' + c.ipHash, 5, 3600);
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      await c.limit('fgt:em:' + (await sha256Hex('em:' + email)).slice(0, 24), 3, 3600);
      const generic = json({ ok: true });         // mesma resposta exista a conta ou não
      if (!mailConfigured(env)) return generic;
      const user = await c.db.getUserByEmail(email);
      if (user) {
        const work = (async () => {
          const token = randomToken(32);
          await c.db.createResetToken(user.id, await sha256Hex(token), now + RESET_TTL_MS);
          await sendResetEmail(env, email, `${/^https:\/\/[a-z0-9.-]+$/i.test(env.PUBLIC_ORIGIN || '') ? env.PUBLIC_ORIGIN : url.origin}/#reset=${token}`, { fetchImpl: deps.fetchImpl });
          await c.audit('reset_requested', { userId: user.id });
        })().catch(() => { console.error(JSON.stringify({ evt: 'reset_mail_failed' })); });
        if (deps.waitUntil) deps.waitUntil(work); else await work;
      }
      return generic;
    }

    case 'POST /api/auth/reset': {
      await c.limit('rst:ip:' + c.ipHash, 10, 3600);
      const body = await readJson(request);
      if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token)) fail(400, 'invalid_reset');
      if (typeof body.newPassword !== 'string') fail(400, 'invalid_password');
      const pe = checkPasswordPolicy(body.newPassword);
      if (pe) passwordError(pe);
      const tokenHash = await sha256Hex(body.token);
      const uid = await c.db.peekResetToken(tokenHash, now);
      if (!uid) fail(400, 'invalid_reset');
      const user = await c.db.getUserById(uid);
      if (!user) fail(400, 'invalid_reset');
      if (checkPasswordPolicy(body.newPassword, user.email)) passwordError(checkPasswordPolicy(body.newPassword, user.email));
      if (user.totp_enabled && !(await checkSecondFactor(c, user, body.totp))) fail(400, 'invalid_code');
      const used = await c.db.consumeResetToken(tokenHash, now);       // uso único
      if (!used) fail(400, 'invalid_reset');
      await c.db.setPassword(uid, await hashPassword(body.newPassword, c.pepper), now);
      await c.db.deleteUserSessions(uid);
      await c.audit('password_reset', { userId: uid });
      return json({ ok: true });
    }

    // ------------------------------------------------------------ sessões
    case 'GET /api/auth/sessions': {
      const { user, idHash } = await c.auth();
      return json({ sessions: await c.db.listSessions(user.id, idHash) });
    }
    case 'POST /api/auth/sessions/revoke-others': {
      const { user, idHash } = await c.auth();
      await c.db.deleteUserSessions(user.id, idHash);
      await c.audit('sessions_revoked', { userId: user.id });
      return json({ ok: true });
    }

    // ------------------------------------------------------------ verificação em duas etapas
    case 'POST /api/auth/totp/setup': {
      const { user } = await c.auth();
      await c.limit('totp:user:' + user.id, 10, 3600);
      const body = await readJson(request);
      const full = await requirePasswordAndFactor(c, user, body);
      if (full.totp_enabled) fail(409, 'totp_already_enabled');
      const secret = newTotpSecret();
      await c.db.setTotpPending(user.id, await sealSecret(secret, c.pepper));
      return json({ secret, uri: otpauthUri(secret, user.email) });
    }
    case 'POST /api/auth/totp/enable': {
      const { user } = await c.auth();
      await c.limit('totp:user:' + user.id, 10, 3600);
      const body = await readJson(request);
      const full = await c.db.getUserById(user.id);
      if (!full.totp_secret || full.totp_enabled) fail(409, 'totp_not_pending');
      const step = await verifyTotp(await openSecret(full.totp_secret, c.pepper), body.code, now);
      if (step === null) fail(400, 'invalid_code');
      await c.db.totpMarkUsed(user.id, step);
      await c.db.enableTotp(user.id);
      await c.db.deleteUserSessions(user.id, (await c.auth()).idHash);
      await c.audit('totp_enabled', { userId: user.id });
      return json({ ok: true });
    }
    case 'POST /api/auth/totp/disable': {
      const { user } = await c.auth();
      await c.limit('totp:user:' + user.id, 10, 3600);
      const body = await readJson(request);
      const full = await c.db.getUserById(user.id);
      if (!full.totp_enabled) fail(409, 'totp_not_enabled');
      await requirePasswordAndFactor(c, user, body);
      await c.db.disableTotp(user.id);
      await c.audit('totp_disabled', { userId: user.id });
      return json({ ok: true });
    }
    case 'POST /api/auth/recovery-codes': {
      const { user } = await c.auth();
      await c.limit('rcg:user:' + user.id, 5, 3600);
      const body = await readJson(request);
      await requirePasswordAndFactor(c, user, body);
      const codes = newRecoveryCodes();
      await c.db.replaceRecoveryCodes(user.id, await Promise.all(codes.map((x) => recoveryHash(c.pepper, x))));
      await c.audit('recovery_codes_regenerated', { userId: user.id });
      return json({ recoveryCodes: codes });
    }

    // ------------------------------------------------------------ dados da conta (LGPD)
    case 'GET /api/account/export': {
      const { user } = await c.auth();
      await c.limit('exp:user:' + user.id, 10, 3600);
      await c.audit('data_export', { userId: user.id });
      return new Response(JSON.stringify(await c.db.exportUser(user.id), null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="agenda-escolar-meus-dados.json"' },
      });
    }
    case 'POST /api/account/delete': {
      const { user } = await c.auth();
      await c.limit('del:user:' + user.id, 5, 3600);
      const body = await readJson(request);
      if (body.confirm !== 'EXCLUIR') fail(400, 'confirmation_required');
      await requirePasswordAndFactor(c, user, body);
      await c.audit('account_delete', { userId: user.id });
      await c.db.deleteUser(user.id);
      return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', 0) });
    }

    // ------------------------------------------------------------ atividades e matérias
    case 'GET /api/sync': {
      const { user } = await c.auth();
      await c.limit('sync:user:' + user.id, 600, 600);
      return json(await c.db.getState(user.id));
    }
    case 'POST /api/sync': {
      const { user } = await c.auth();
      await c.limit('sync:user:' + user.id, 600, 600);
      const ops = validateSyncBody(await readJson(request));
      try { await c.db.applySync(user.id, ops, now); }
      catch (e) { if (String(e && e.message).includes('limit_exceeded')) fail(422, 'limit_exceeded'); throw e; }
      return json(await c.db.getState(user.id));
    }

    // ------------------------------------------------------------ notificações
    case 'POST /api/push/subscribe': {
      const { user } = await c.auth();
      await c.limit('push:user:' + user.id, 30, 3600);
      const body = await readJson(request);
      const sub = validatePushSub(body.subscription);
      if (body.tz !== undefined && !validTimeZone(body.tz)) fail(400, 'invalid_prefs');
      const prefs = validatePrefs({ hour: body.hour });
      const r = await c.db.addPushSub(user.id, { id: randomToken(12), ...sub }, now);
      if (r.error) fail(409, 'too_many_devices');
      await c.db.setNotifPrefs(user.id, { enabled: true, hour: prefs.hour, tz: body.tz });
      await c.audit('push_subscribe', { userId: user.id });
      return json({ ok: true });
    }
    case 'POST /api/push/unsubscribe': {
      const { user } = await c.auth();
      const body = await readJson(request);
      if (typeof body.endpoint !== 'string' || body.endpoint.length > 600) fail(400, 'invalid_push');
      await c.db.removePushSub(user.id, body.endpoint);          // só remove inscrições da própria conta
      if ((await c.db.countPushSubs(user.id)) === 0) await c.db.setNotifPrefs(user.id, { enabled: false });
      return json({ ok: true });
    }
    case 'PUT /api/push/prefs': {
      const { user } = await c.auth();
      await c.limit('push:user:' + user.id, 30, 3600);
      const body = await readJson(request);
      const prefs = validatePrefs(body);
      if (body.tz !== undefined) { if (!validTimeZone(body.tz)) fail(400, 'invalid_prefs'); prefs.tz = body.tz; }
      await c.db.setNotifPrefs(user.id, prefs);
      return json({ ok: true });
    }
    case 'POST /api/push/test': {
      const { user } = await c.auth();
      await c.limit('pusht:user:' + user.id, 5, 3600);
      if (!vapidConfigured(env)) fail(503, 'push_not_configured');
      const subs = await c.db.listPushSubs(user.id);
      let sent = 0;
      for (const s of subs) {
        const r = await sendWebPush(s, { title: 'Agenda Escolar', body: 'Teste: os avisos estão funcionando neste aparelho.', tag: 'teste', url: './' }, env, { fetchImpl: deps.fetchImpl, nowSec: Math.floor(now / 1000) }).catch(() => ({ ok: false }));
        if (r.ok) sent++; else if (r.gone) await c.db.deletePushSubById(s.id);
      }
      return json({ sent, devices: subs.length });
    }

    default: {
      if (path.startsWith('/api/')) fail(path in KNOWN_PATHS ? 405 : 404, path in KNOWN_PATHS ? 'method_not_allowed' : 'not_found');
      fail(404, 'not_found');
    }
  }
}

const KNOWN_PATHS = Object.fromEntries([
  '/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/change-password', '/api/auth/recover',
  '/api/auth/forgot', '/api/auth/reset', '/api/auth/sessions', '/api/auth/sessions/revoke-others', '/api/auth/totp/setup',
  '/api/auth/totp/enable', '/api/auth/totp/disable', '/api/auth/recovery-codes', '/api/account/export', '/api/account/delete',
  '/api/sync', '/api/push/subscribe', '/api/push/unsubscribe', '/api/push/prefs', '/api/push/test',
].map((p) => [p, 1]));

// ---------------------------------------------------------------- robots.txt e sitemap.xml (usam o endereço real pelo qual o site foi aberto; nada de domínio escrito no código)
export const PUBLIC_PAGES = ['/', '/privacidade.html', '/termos.html', '/cookies.html'];
export const robotsTxt = (origin) => `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`;
export const sitemapXml = (origin) => '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  PUBLIC_PAGES.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n') + '\n</urlset>\n';

// ---------------------------------------------------------------- entrada principal
export async function handle(request, env, deps = {}) {
  const now = (deps.now || Date.now)();
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');
  let res;
  try {
    if (isApi) res = await api(request, url, env, deps, now);
    else if (request.method !== 'GET' && request.method !== 'HEAD') res = json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' });
    else if (url.pathname === '/robots.txt') res = new Response(robotsTxt(url.origin), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    else if (url.pathname === '/sitemap.xml') res = new Response(sitemapXml(url.origin), { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
    else res = await env.ASSETS.fetch(request);
  } catch (e) {
    if (e instanceof HttpError) res = json({ error: e.code }, e.status, e.headers || {});
    else if (e instanceof ValidationError) res = json({ error: e.code, field: e.field }, 400);
    else {
      // Registra só o tipo do erro e a rota: nunca o corpo do pedido, senhas, tokens ou e-mails.
      console.error(JSON.stringify({ evt: 'unhandled', route: `${request.method} ${url.pathname}`, name: e && e.name }));
      res = json({ error: 'internal' }, 500);
    }
  }
  return withSecurityHeaders(res, { api: isApi });
}

// ---------------------------------------------------------------- tarefa agendada (a cada hora)
export async function runScheduled(env, deps = {}) {
  const now = (deps.now || Date.now)();
  if (!env.DB) return { skipped: 'no_db' };
  const db = env.DB.get(env.DB.idFromName('main'));
  await db.purge(now);
  if (!vapidConfigured(env)) return { skipped: 'no_vapid' };
  const maxUsers = Math.max(1, Math.min(200, parseInt(env.MAX_PUSH_PER_RUN || '12', 10) || 12));
  const due = await db.dueDigests(now, maxUsers);
  let sent = 0, failed = 0;
  for (const u of due) {
    const msg = digestMessage(buildDigest(u.items, u.today));
    if (!msg) { await db.markDigestSent(u.userId, u.today); continue; }
    const payload = { title: msg.title, body: msg.body, tag: 'digest-' + u.today, url: './' };
    let anyOk = false;
    for (const s of u.subs) {
      try {
        const r = await sendWebPush(s, payload, env, { fetchImpl: deps.fetchImpl, nowSec: Math.floor(now / 1000) });
        if (r.ok) { anyOk = true; sent++; await db.resetPushFail(s.id); }
        else if (r.gone) await db.deletePushSubById(s.id);
        else { failed++; await db.bumpPushFail(s.id); }
      } catch { failed++; await db.bumpPushFail(s.id); }
    }
    if (anyOk || u.subs.length === 0) await db.markDigestSent(u.userId, u.today);
  }
  return { users: due.length, sent, failed };
}
