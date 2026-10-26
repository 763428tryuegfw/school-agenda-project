// Arquivos enviados pelo usuário: validação PELO CONTEÚDO (o servidor não confia no tipo nem no nome que o navegador diz),
// limites e nome seguro. Funções puras, testadas em Node (test/files.test.mjs).

export const CHUNK_BYTES = 1024 * 1024;           // cada pedaço fica numa linha do SQLite (limite da linha: 2 MB)
export const MAX_ITEM_FILES = 10;                 // anexos por atividade
const MB = 1024 * 1024;

/** Limites; os dois primeiros podem ser trocados em wrangler.jsonc > vars (MAX_FILE_MB, ACCOUNT_QUOTA_MB). */
export function fileLimits(env = {}) {
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    maxFileBytes: Math.floor(num(env.MAX_FILE_MB, 20, 1, 25) * MB),
    accountBytes: Math.floor(num(env.ACCOUNT_QUOTA_MB, 100, 10, 1000) * MB),
    maxFiles: 100,
    maxItemFiles: MAX_ITEM_FILES,
  };
}

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));
const FTYP_IMG = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);
const FTYP_MP4 = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'm4v ', 'm4a ', 'dash', 'mmp4', 'f4v ']);
const FTYP_3GP = new Set(['3gp4', '3gp5', '3gp6', '3g2a', '3ge6']);

// Tipos aceitos: ext = extensões permitidas para esse conteúdo; inline = o navegador pode exibir dentro da página.
const T = {
  jpeg: { kind: 'image', mime: 'image/jpeg', ext: ['jpg', 'jpeg', 'jpe'], inline: true },
  png: { kind: 'image', mime: 'image/png', ext: ['png'], inline: true },
  gif: { kind: 'image', mime: 'image/gif', ext: ['gif'], inline: true },
  webp: { kind: 'image', mime: 'image/webp', ext: ['webp'], inline: true },
  heic: { kind: 'image', mime: 'image/heic', ext: ['heic', 'heif'], inline: false },
  pdf: { kind: 'pdf', mime: 'application/pdf', ext: ['pdf'], inline: false },
  mp4: { kind: 'video', mime: 'video/mp4', ext: ['mp4', 'm4v'], inline: true },
  mov: { kind: 'video', mime: 'video/quicktime', ext: ['mov', 'qt'], inline: true },
  gp3: { kind: 'video', mime: 'video/3gpp', ext: ['3gp', '3g2'], inline: true },
  webm: { kind: 'video', mime: 'video/webm', ext: ['webm'], inline: true },
  zipdoc: { kind: 'doc', mime: 'application/octet-stream', ext: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'], inline: false },
  text: { kind: 'text', mime: 'text/plain; charset=utf-8', ext: ['txt', 'csv', 'md'], inline: false },
};

/** Extensão (minúscula, sem ponto) do nome informado, ou ''. */
export const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };

/**
 * Descobre o tipo real do arquivo olhando os primeiros bytes. Devolve { kind, mime, inline, ext } ou null.
 * Recusa quando a extensão do nome não combina com o conteúdo (ex.: um PDF chamado foto.jpg), e tudo que não está na lista
 * (SVG, HTML, scripts, executáveis, compactados...).
 */
export function detectFile(bytes, name) {
  const ext = extOf(name);
  if (!ext || !bytes || bytes.length < 4) return null;
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let id = null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) id = 'jpeg';
  else if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) id = 'png';
  else if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) id = 'gif';
  else if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') id = 'webp';
  else if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') id = 'pdf';
  else if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) id = 'webm';
  else if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (FTYP_IMG.has(brand)) id = 'heic';
    else if (brand === 'qt  ') id = 'mov';
    else if (FTYP_3GP.has(brand)) id = 'gp3';
    else if (FTYP_MP4.has(brand)) id = ext === 'mov' ? 'mov' : 'mp4';   // câmeras do iPhone gravam .mov com marca de MP4
  } else if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04) id = 'zipdoc';
  else id = isPlainText(b) ? 'text' : null;
  if (!id) return null;
  const t = T[id];
  if (!t.ext.includes(ext)) return null;
  return { id, kind: t.kind, mime: t.mime, inline: t.inline, ext };
}

/** Texto simples: UTF-8 válido, sem byte nulo e sem caracteres de controle (exceto tab, quebra de linha). Até 1 MB. */
function isPlainText(b) {
  if (b.length > MB) return false;
  for (let i = 0; i < b.length; i++) { const c = b[i]; if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) return false; }
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
}

/** Nome para exibir: sem caminho, sem caracteres de controle ou de inversão de texto, até 100 caracteres, extensão preservada. */
export function safeName(raw, fallbackExt) {
  let s = String(raw || '').normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^\.[A-Za-z0-9]{1,8}$/.test(s)) s = '';          // nome que é só ".png": vira "arquivo.png"
  s = s.replace(/^[.\s]+/, '');
  const ext = extOf(s) || fallbackExt || '';
  if (s.length > 100) { const base = s.slice(0, s.length - (ext ? ext.length + 1 : 0)); s = base.slice(0, 100 - (ext ? ext.length + 1 : 0)).trimEnd() + (ext ? '.' + ext : ''); }
  if (!s || s === '.' + ext) s = 'arquivo' + (ext ? '.' + ext : '');
  return s;
}

/** Cabeçalho Content-Disposition seguro (nome ASCII de reserva + nome UTF-8 codificado). */
export function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\%]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Interpreta "Range: bytes=a-b" de um só trecho. Devolve {start,end} (inclusive), null (sem Range) ou 'invalid'. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') { const n = Number(m[2]); if (n === 0) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
  return { start, end };
}
