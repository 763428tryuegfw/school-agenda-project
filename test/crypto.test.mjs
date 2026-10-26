import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, checkPasswordPolicy, PBKDF2_ITERATIONS } from '../src/passwords.js';
import { hotp, verifyTotp, base32Decode, base32Encode, sealSecret, openSecret, totpStep } from '../src/totp.js';
import { encryptWebPush, vapidHeader } from '../src/webpush.js';
import { b64uDecode, b64uEncode, utf8, fromUtf8 } from '../src/util.js';

const PEPPER = 'pepper-de-teste-pepper-de-teste-pepper-de-teste-0123456789';

test('senha: hash verifica, nunca contém a senha, sal diferente a cada vez', async () => {
  const a = await hashPassword('Uma-Senha-Forte-123', PEPPER);
  const b = await hashPassword('Uma-Senha-Forte-123', PEPPER);
  assert.notEqual(a, b);
  assert.ok(!a.includes('Uma-Senha'));
  assert.ok(a.startsWith('pbkdf2-sha512$' + PBKDF2_ITERATIONS + '$'));
  assert.deepEqual(await verifyPassword('Uma-Senha-Forte-123', a, PEPPER), { ok: true, needsRehash: false });
  assert.equal((await verifyPassword('Uma-Senha-Forte-124', a, PEPPER)).ok, false);
  assert.equal((await verifyPassword('Uma-Senha-Forte-123', a, PEPPER + 'x')).ok, false, 'pepper diferente não valida');
  assert.equal((await verifyPassword('x', 'lixo$lixo', PEPPER)).ok, false);
  assert.equal((await verifyPassword('x', '', PEPPER)).ok, false);
});

test('senha: hash antigo (menos iterações) pede rehash', async () => {
  // fabrica um hash com 50.000 iterações usando o mesmo esquema
  const { hmacSha256 } = await import('../src/util.js');
  const salt = new Uint8Array(16).fill(7);
  const pre = await hmacSha256(utf8(PEPPER), 'abc'.normalize('NFKC'));
  const key = await crypto.subtle.importKey('raw', pre, 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 50000 }, key, 512));
  const stored = `pbkdf2-sha512$50000$${b64uEncode(salt)}$${b64uEncode(bits)}`;
  assert.deepEqual(await verifyPassword('abc', stored, PEPPER), { ok: true, needsRehash: true });
});

test('política de senha', () => {
  assert.equal(checkPasswordPolicy('curta', 'a@b.co'), 'too_short');
  assert.equal(checkPasswordPolicy('x'.repeat(129)), 'too_long');
  assert.equal(checkPasswordPolicy('1234567890'), 'too_common');
  assert.equal(checkPasswordPolicy('aaaaaaaaaaaa'), 'too_common');
  assert.equal(checkPasswordPolicy('joaozinho123', 'joaozinho@example.com'), 'same_as_email');
  assert.equal(checkPasswordPolicy('joaozinho@example.com', 'joaozinho@example.com'), 'same_as_email');
  assert.equal(checkPasswordPolicy('Correct-Horse-Battery-9', 'joaozinho@example.com'), null);
  assert.equal(checkPasswordPolicy('frase longa com espaços e acentuação ção', null), null);
  assert.equal(checkPasswordPolicy(12345678901234, null), 'invalid');
});

test('HOTP bate com os vetores do RFC 4226', async () => {
  const secret = utf8('12345678901234567890');
  const expect = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  for (let i = 0; i < expect.length; i++) assert.equal(await hotp(secret, i), expect[i]);
});

test('TOTP: RFC 6238 (t=59 -> 287082), janela e base32', async () => {
  const secretB32 = base32Encode(utf8('12345678901234567890'));
  assert.equal(secretB32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(base32Decode(secretB32), utf8('12345678901234567890'));
  assert.equal(await verifyTotp(secretB32, '287082', 59000), 1);
  assert.equal(await verifyTotp(secretB32, '287082', 59000 + 30000), 1, 'aceita o passo anterior (±1)');
  assert.equal(await verifyTotp(secretB32, '287082', 59000 + 90000), null, 'rejeita fora da janela');
  assert.equal(await verifyTotp(secretB32, '12345', 59000), null);
  assert.equal(await verifyTotp(secretB32, 'abcdef', 59000), null);
  assert.equal(totpStep(59000), 1);
});

test('segredo TOTP é cifrado em repouso', async () => {
  const sealed = await sealSecret('JBSWY3DPEHPK3PXP', PEPPER);
  assert.ok(sealed.startsWith('v1.') && !sealed.includes('JBSWY3DP'));
  assert.equal(await openSecret(sealed, PEPPER), 'JBSWY3DPEHPK3PXP');
  await assert.rejects(() => openSecret(sealed, PEPPER + 'x'));
});

test('Web Push: criptografia idêntica ao vetor de teste do RFC 8291 (seção 5)', async () => {
  const plaintext = b64uDecode('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24');
  assert.equal(fromUtf8(plaintext), 'When I grow up, I want to be a watermelon');
  const body = await encryptWebPush(plaintext,
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: 'DGv6ra1nlYgDCS1FRnbzlw', asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' });
  assert.equal(b64uEncode(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('Web Push: com chave efêmera aleatória, o navegador (chave privada do RFC) consegue decifrar', async () => {
  // Decifra do lado do "navegador" usando a chave privada do vetor do RFC e um HKDF/AES-GCM independentes
  const uaPriv = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';
  const uaPubB = b64uDecode('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const auth = b64uDecode('BTBZMqHH6r4Tts7J_aSIgg');
  const msg = utf8(JSON.stringify({ title: 'Oi', body: 'Prova amanhã ✓' }));
  const body = await encryptWebPush(msg, { p256dh: b64uEncode(uaPubB), auth: b64uEncode(auth) });
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const priv = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: uaPriv, x: b64uEncode(uaPubB.slice(1, 33)), y: b64uEncode(uaPubB.slice(33)) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, priv, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const info = new Uint8Array([...utf8('WebPush: info\0'), ...uaPubB, ...asPub]);
  const ikm = await hk(auth, secret, info, 32);
  const cek = await hk(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(fromUtf8(plain.slice(0, -1)), fromUtf8(msg));
});

test('Web Push: payload grande demais e inscrição inválida são recusados', async () => {
  const sub = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  await assert.rejects(() => encryptWebPush(new Uint8Array(4000), sub));
  await assert.rejects(() => encryptWebPush(utf8('x'), { p256dh: 'AAAA', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }));
});

test('VAPID: JWT ES256 assinado e verificável com a chave pública', async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const env = { VAPID_PUBLIC: b64uEncode(pub), VAPID_PRIVATE: jwk.d, VAPID_SUBJECT: 'mailto:contato@example.com' };
  const h = await vapidHeader('https://fcm.googleapis.com/fcm/send/abc', env, 1_800_000_000);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  assert.ok(m, h);
  const claims = JSON.parse(fromUtf8(b64uDecode(m[2])));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:contato@example.com' });
  assert.equal(JSON.parse(fromUtf8(b64uDecode(m[1]))).alg, 'ES256');
  assert.equal(m[4], env.VAPID_PUBLIC);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64uDecode(m[3]), utf8(`${m[1]}.${m[2]}`));
  assert.ok(ok);
});
