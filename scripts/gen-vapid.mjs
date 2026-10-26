// Gera o par de chaves dos avisos (Web Push / VAPID). Rode:  npm run vapid
//  - VAPID_PUBLIC  : pode ficar no wrangler.jsonc (é pública).
//  - VAPID_PRIVATE : SEGREDO. Cadastre no Cloudflare como segredo; nunca envie para o GitHub.
import { webcrypto as crypto } from 'node:crypto';
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.log('VAPID_PUBLIC=' + pub);
console.log('VAPID_PRIVATE=' + jwk.d);
