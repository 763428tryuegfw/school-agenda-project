// Web Push sem dependências: criptografia da mensagem (RFC 8291, aes128gcm) e identificação do servidor (VAPID, RFC 8292).
// Verificado contra o vetor de teste do próprio RFC 8291 (test/webpush.test.mjs).
import { b64uEncode, b64uDecode, concat, randomBytes, utf8 } from './util.js';

const hkdf = async (salt, ikm, info, bytes) => {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
};

/**
 * Criptografa `payload` (Uint8Array) para a inscrição push de um navegador.
 * `opts` (salt, asPrivate/asPublic em base64url) existe só para o teste com o vetor do RFC.
 */
export async function encryptWebPush(payload, { p256dh, auth }, opts = {}) {
  if (payload.length > 3900) throw new Error('payload grande demais');
  const uaPub = b64uDecode(p256dh);
  const authSecret = b64uDecode(auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || authSecret.length !== 16) throw new Error('inscrição inválida');

  let asPriv, asPub;
  if (opts.asPrivate) {
    asPub = b64uDecode(opts.asPublic);
    asPriv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: opts.asPrivate, x: b64uEncode(asPub.slice(1, 33)), y: b64uEncode(asPub.slice(33)), ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
  const salt = opts.salt ? b64uDecode(opts.salt) : randomBytes(16);

  const keyInfo = concat(utf8('WebPush: info\0'), uaPub, asPub);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const plain = concat(payload, new Uint8Array([2]));               // 0x02 = último (e único) registro
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** Cabeçalho Authorization VAPID: JWT ES256 assinado com a chave privada do servidor. */
export async function vapidHeader(endpoint, env, nowSec) {
  const pub = b64uDecode(env.VAPID_PUBLIC);
  const jwk = { kty: 'EC', crv: 'P-256', d: env.VAPID_PRIVATE, x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC}`;
}

export const vapidConfigured = (env) => !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE && env.VAPID_SUBJECT);

/** Envia uma notificação. Devolve { ok, gone, status }. `gone` = inscrição não existe mais (404/410). */
export async function sendWebPush(sub, message, env, { fetchImpl = fetch, nowSec = Math.floor(Date.now() / 1000), ttl = 43200 } = {}) {
  const body = await encryptWebPush(utf8(JSON.stringify(message)), sub);
  const res = await fetchImpl(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, env, nowSec),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body,
    redirect: 'manual',                        // nunca seguir redirecionamentos (defesa extra contra SSRF)
    signal: AbortSignal.timeout(8000),
  });
  return { ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410, status: res.status };
}
