// Senhas: política, hash e verificação.
//
// Algoritmo: PBKDF2-HMAC-SHA512 com 100.000 iterações (o máximo que o Web Crypto do Cloudflare Workers
// aceita), sal aleatório de 16 bytes por senha e um "pepper" secreto (HMAC-SHA256) aplicado antes.
// O pepper fica só nos segredos do Worker: quem vazar apenas o banco não consegue testar senhas offline.
//
// LIMITAÇÃO CONHECIDA (ver SECURITY-AUDIT.md): o prompt de segurança pede Argon2id. Argon2id não existe
// no Web Crypto e este ambiente de desenvolvimento não tinha acesso a pacotes npm para trazer uma versão
// WASM auditada. O formato do hash é versionado ("pbkdf2-sha512$...") e verifyPassword() informa
// needsRehash, então a troca para Argon2id pode ser feita depois sem obrigar ninguém a redefinir a senha.
import { b64uEncode, b64uDecode, randomBytes, hmacSha256, utf8, timingSafeEqual } from './util.js';

export const PBKDF2_ITERATIONS = 100000;
const SCHEME = 'pbkdf2-sha512';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Senhas muito comuns (amostra curta; a checagem principal é o tamanho mínimo).
const COMMON = new Set([
  '1234567890', '12345678910', '0123456789', 'qwertyuiop', 'password12', 'password123', 'senha12345', 'senha123456',
  '123456789a', 'abc1234567', 'abcd123456', 'iloveyou12', 'minhasenha', 'minhasenha1', 'minhasenha123', 'mudar12345',
  'agenda1234', 'agenda12345', 'escola12345', 'brasil1234', 'brasil12345', 'corinthians', 'flamengo123', 'palmeiras1',
  'q1w2e3r4t5', '1q2w3e4r5t', 'qazwsxedc1', 'passw0rd12', 'p@ssw0rd12', 'letmein123', 'welcome123', 'football123',
  '0000000000', '1111111111', '1234512345', 'aaaaaaaaaa', 'asdfghjkl1', 'asdfghjklç', 'zxcvbnm123', 'senhasenha1',
]);

/** Devolve um código de erro ('too_short', 'too_long', 'too_common', 'same_as_email') ou null se estiver ok. */
export function checkPasswordPolicy(password, email) {
  if (typeof password !== 'string') return 'invalid';
  const len = [...password].length;
  if (len < PASSWORD_MIN) return 'too_short';
  if (len > PASSWORD_MAX) return 'too_long';
  const low = password.toLowerCase();
  if (COMMON.has(low)) return 'too_common';
  if (/^(.)\1+$/.test(password)) return 'too_common';
  if (email) {
    const local = String(email).toLowerCase().split('@')[0];
    const full = String(email).toLowerCase();
    // senha igual ao e-mail, ao nome antes do @, ou esse nome com poucos caracteres a mais
    if (low === full || low === local || (local.length >= 4 && low.includes(local) && low.length <= local.length + 3)) {
      return 'same_as_email';
    }
  }
  return null;
}

async function derive(password, pepper, salt, iterations) {
  const pre = await hmacSha256(utf8(pepper), password.normalize('NFKC'));
  const key = await crypto.subtle.importKey('raw', pre, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations }, key, 512);
  return new Uint8Array(bits);
}

export async function hashPassword(password, pepper) {
  if (!pepper) throw new Error('pepper ausente');
  const salt = randomBytes(16);
  const h = await derive(password, pepper, salt, PBKDF2_ITERATIONS);
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${b64uEncode(salt)}$${b64uEncode(h)}`;
}

/** @returns {Promise<{ok:boolean, needsRehash:boolean}>} */
export async function verifyPassword(password, stored, pepper) {
  try {
    const [scheme, iterStr, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== SCHEME) return { ok: false, needsRehash: false };
    const iterations = parseInt(iterStr, 10);
    if (!Number.isInteger(iterations) || iterations < 1000 || iterations > PBKDF2_ITERATIONS) return { ok: false, needsRehash: false };
    const h = await derive(password, pepper, b64uDecode(saltB64), iterations);
    const ok = timingSafeEqual(h, b64uDecode(hashB64));
    return { ok, needsRehash: ok && iterations < PBKDF2_ITERATIONS };
  } catch {
    return { ok: false, needsRehash: false };
  }
}

// Hash "falso" para igualar o tempo de resposta quando o e-mail não existe.
let dummy = null;
export async function dummyVerify(password, pepper) {
  dummy = dummy || (await hashPassword('senha-falsa-para-igualar-tempo', pepper));
  await verifyPassword(password, dummy, pepper);
}
