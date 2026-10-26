// Verificação em duas etapas (TOTP, RFC 6238) com HMAC-SHA1, 6 dígitos, passo de 30 s.
import { randomBytes, concat, b64uEncode, b64uDecode, utf8, fromUtf8 } from './util.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export async function hotp(secretBytes, counter, digits = 6) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs) => Math.floor(nowMs / 1000 / 30);

/** Aceita o passo atual e ±1 (relógios levemente fora de hora). Devolve o passo aceito ou null. */
export async function verifyTotp(secretB32, code, nowMs, window = 1) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const secret = base32Decode(secretB32);
  const step = totpStep(nowMs);
  let found = null;
  for (let d = -window; d <= window; d++) {
    const expect = await hotp(secret, step + d);
    // sem retorno antecipado: o tempo não depende de qual janela bateu
    if (expect === c && found === null) found = step + d;
  }
  return found;
}

export function otpauthUri(secretB32, accountLabel, issuer = 'Agenda Escolar') {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Segredo TOTP cifrado em repouso (AES-GCM) com chave derivada do PEPPER via HKDF.
async function aesKey(pepper) {
  const ikm = await crypto.subtle.importKey('raw', utf8(pepper), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8('agenda-escolar'), info: utf8('totp-secret-v1') },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealSecret(secretB32, pepper) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(pepper), utf8(secretB32)));
  return 'v1.' + b64uEncode(concat(iv, ct));
}

export async function openSecret(sealed, pepper) {
  if (!String(sealed).startsWith('v1.')) throw new Error('formato desconhecido');
  const raw = b64uDecode(String(sealed).slice(3));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(pepper), raw.slice(12));
  return fromUtf8(new Uint8Array(pt));
}
