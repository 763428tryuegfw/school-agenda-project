// Varredura simples de segredos no repositório (padrões conhecidos). NÃO substitui ferramentas como gitleaks/trufflehog:
// serve como rede de segurança rápida e roda nos testes. Ignora test/ (que contém valores públicos de vetores de teste dos RFCs).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'assets-src', '.wrangler']);
const BIN = /\.(png|jpg|jpeg|gif|ico|webp|zip|woff2?|sqlite)$/i;
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'chave privada PEM'],
  [/AKIA[0-9A-Z]{16}/, 'chave de acesso AWS'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'token do GitHub'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'token do GitHub'],
  [/sk_(live|test)_[A-Za-z0-9]{16,}/, 'chave de API (Stripe)'],
  [/re_[A-Za-z0-9]{20,}/, 'chave de API (Resend)'],
  [/(secret|token|pepper|password|passwd|api[_-]?key|private[_-]?key|vapid_private)[A-Za-z_]*["']?\s*[:=]\s*["'][A-Za-z0-9+\/_=-]{24,}["']/i, 'atribuição de segredo com valor literal'],
  [/^(PEPPER|VAPID_PRIVATE|RESEND_API_KEY)\s*=\s*[A-Za-z0-9+\/_=-]{20,}\s*$/m, 'segredo em arquivo de variáveis'],
];

export function scan(root = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p); continue; }
      const rel = relative(root, p);
      if (/^\.(env|dev\.vars)(\..*)?$/.test(name) && !name.endsWith('.example')) { found.push({ file: rel, what: 'arquivo de segredos no repositório' }); continue; }
      if (/\.sqlite/.test(name)) { found.push({ file: rel, what: 'banco de dados no repositório' }); continue; }
      if (BIN.test(name) || st.size > 2e6) continue;
      const text = readFileSync(p, 'utf8');
      for (const [re, what] of PATTERNS) if (re.test(text)) found.push({ file: rel, what });
    }
  };
  walk(root);
  return found;
}

if (process.argv[1] && basename(process.argv[1]) === 'scan-secrets.mjs') {
  const f = scan();
  if (f.length) { for (const x of f) console.log(`ENCONTRADO: ${x.file} (${x.what})`); process.exit(1); }
  console.log('Nenhum segredo encontrado pelos padrões conhecidos.');
}
