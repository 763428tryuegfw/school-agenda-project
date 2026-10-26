// Gera um segredo aleatório (384 bits) para usar como PEPPER. Rode:  npm run secret
// Copie o resultado e cadastre no Cloudflare como SEGREDO com o nome PEPPER. Não envie para o GitHub.
import { webcrypto as crypto } from 'node:crypto';
const b = crypto.getRandomValues(new Uint8Array(48));
console.log(Buffer.from(b).toString('base64url'));
