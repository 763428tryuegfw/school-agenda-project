// Validação de entradas no SERVIDOR (o front-end valida só para dar resposta rápida; aqui é a barreira real).
// Regras: tipos explícitos, tamanhos máximos, campos desconhecidos descartados (evita mass assignment).
import { TIPOS, ISO_RE } from '../public/digest.js';

export const LIMITS = {
  items: 5000,
  materias: 100,
  comps: 30,
  batch: 1000,
  bodyBytes: 512 * 1024,
};

// Serviços de push de Chrome/Edge/Android (FCM), Firefox, Safari/iOS (Apple) e Windows (WNS)
export const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
// Caracteres de controle (exceto tab/nova linha, que a observação aceita)
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class ValidationError extends Error {
  constructor(code, field) { super(code); this.code = code; this.field = field; }
}
const bad = (code, field) => { throw new ValidationError(code, field); };

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') bad('invalid_email', 'email');
  const e = raw.normalize('NFKC').trim().toLowerCase();
  if (e.length < 6 || e.length > 254 || !EMAIL_RE.test(e) || CTRL.test(e) || e.split('@').length !== 2) bad('invalid_email', 'email');
  const [local, domain] = e.split('@');
  if (local.length > 64 || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) bad('invalid_email', 'email');
  return e;
}

function text(v, field, { min = 0, max, multiline = false, required = false }) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') bad('invalid_' + field, field);
  const s = v.normalize('NFC').trim();
  if ((required || min > 0) && s.length < Math.max(min, 1)) bad('invalid_' + field, field);
  if (s.length > max) bad('invalid_' + field, field);
  if (CTRL.test(s) || (!multiline && /[\n\r\t]/.test(s))) bad('invalid_' + field, field);
  return s;
}

export function isRealDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function validateItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid_item', 'item');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) bad('invalid_id', 'id');
  if (typeof raw.tipo !== 'string' || !Object.prototype.hasOwnProperty.call(TIPOS, raw.tipo)) bad('invalid_tipo', 'tipo');
  if (!isRealDate(raw.data)) bad('invalid_data', 'data');
  const o = {
    id: raw.id,
    titulo: text(raw.titulo, 'titulo', { min: 1, max: 120 }),
    materia: text(raw.materia || 'Geral', 'materia', { min: 1, max: 40 }),
    tipo: raw.tipo,
    data: raw.data,
    obs: text(raw.obs, 'obs', { max: 300, multiline: true }),
    feita: raw.feita === true,
    feitaEm: null,
    comp: null,
  };
  if (o.feita) {
    if (raw.feitaEm !== undefined && raw.feitaEm !== null && !isRealDate(raw.feitaEm)) bad('invalid_feitaEm', 'feitaEm');
    o.feitaEm = raw.feitaEm || o.data;
  }
  if (raw.comp !== undefined && raw.comp !== null && raw.comp !== '') {
    if (typeof raw.comp !== 'string' || !ID_RE.test(raw.comp)) bad('invalid_comp', 'comp');
    o.comp = raw.comp;
  }
  return o;
}

export function validateMateria(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid_materia', 'materia');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) bad('invalid_id', 'id');
  if (!Array.isArray(raw.comps) || raw.comps.length > LIMITS.comps) bad('invalid_comps', 'comps');
  const seen = new Set();
  const comps = raw.comps.map((c) => {
    if (!c || typeof c !== 'object') bad('invalid_comps', 'comps');
    if (typeof c.id !== 'string' || !ID_RE.test(c.id) || seen.has(c.id)) bad('invalid_comps', 'comps');
    seen.add(c.id);
    const max = Number(c.max);
    if (!Number.isFinite(max) || max <= 0 || max > 100) bad('invalid_comps', 'comps');
    let tirei = null;
    if (c.tirei !== null && c.tirei !== undefined && c.tirei !== '') {
      tirei = Number(c.tirei);
      if (!Number.isFinite(tirei) || tirei < 0 || tirei > max) bad('invalid_comps', 'comps');
      tirei = Math.round(tirei * 100) / 100;
    }
    return { id: c.id, nome: text(c.nome, 'comps', { min: 1, max: 40 }), max: Math.round(max * 100) / 100, tirei };
  });
  return { id: raw.id, nome: text(raw.nome, 'nome', { min: 1, max: 40 }), comps };
}

/** Nome de matéria vindo de um cabeçalho (envio de arquivos): mesmas regras da matéria da atividade. */
export const validateMateriaName = (v) => text(v, 'materia', { min: 1, max: 40 });
export const isValidId = (v) => typeof v === 'string' && ID_RE.test(v);

export function validateIdList(arr, field) {
  if (arr === undefined) return [];
  if (!Array.isArray(arr) || arr.length > LIMITS.batch) bad('invalid_' + field, field);
  return arr.map((id) => { if (typeof id !== 'string' || !ID_RE.test(id)) bad('invalid_id', field); return id; });
}

/** Valida o corpo do POST /api/sync. */
export function validateSyncBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('invalid_body', 'body');
  const sec = (k) => {
    const s = body[k] === undefined ? {} : body[k];
    if (!s || typeof s !== 'object' || Array.isArray(s)) bad('invalid_body', k);
    const up = s.upsert === undefined ? [] : s.upsert;
    if (!Array.isArray(up) || up.length > LIMITS.batch) bad('invalid_body', k);
    return { upsert: up, delete: validateIdList(s.delete, k) };
  };
  const items = sec('items'), materias = sec('materias');
  const ids = new Set();
  const uitems = items.upsert.map((r) => { const v = validateItem(r); if (ids.has(v.id)) bad('duplicate_id', 'items'); ids.add(v.id); return v; });
  const mids = new Set();
  const umat = materias.upsert.map((r) => { const v = validateMateria(r); if (mids.has(v.id)) bad('duplicate_id', 'materias'); mids.add(v.id); return v; });
  return { items: { upsert: uitems, delete: items.delete }, materias: { upsert: umat, delete: materias.delete } };
}

export function validatePrefs(body) {
  if (!body || typeof body !== 'object') bad('invalid_body', 'body');
  const out = {};
  if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') bad('invalid_prefs', 'enabled'); out.enabled = body.enabled; }
  if (body.hour !== undefined) {
    if (!Number.isInteger(body.hour) || body.hour < 0 || body.hour > 23) bad('invalid_prefs', 'hour');
    out.hour = body.hour;
  }
  return out;
}

export function validatePushSub(body) {
  if (!body || typeof body !== 'object') bad('invalid_body', 'body');
  const { endpoint, keys } = body;
  if (typeof endpoint !== 'string' || endpoint.length > 600) bad('invalid_push', 'endpoint');
  let u;
  try { u = new URL(endpoint); } catch { bad('invalid_push', 'endpoint'); }
  // Proteção contra SSRF: o servidor vai fazer uma requisição para este endereço, então só aceitamos
  // HTTPS, sem credenciais/porta, e somente os serviços de push dos navegadores (lista fechada).
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) bad('invalid_push', 'endpoint');
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((s) => host === s || host.endsWith('.' + s))) bad('invalid_push', 'endpoint');
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') bad('invalid_push', 'keys');
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth)) bad('invalid_push', 'keys');
  return { endpoint: u.toString(), p256dh: keys.p256dh, auth: keys.auth };
}
