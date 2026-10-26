import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeClient, register } from './helpers.mjs';

const it = (id, extra = {}) => ({ id, titulo: 'Título ' + id, materia: 'Matemática', tipo: 'tarefa', data: '2026-10-20', ...extra });
const up = (...items) => ({ items: { upsert: items } });
async function two() {
  const { env, db } = makeEnv();
  const a = makeClient(env, { ip: '198.51.100.11' }), b = makeClient(env, { ip: '198.51.100.12' });
  await register(a); await register(b);
  return { env, db, a, b };
}

test('sync: sem sessão não lê nem grava', async () => {
  const { env } = makeEnv();
  const c = makeClient(env);
  assert.equal((await c.get('/api/sync')).status, 401);
  assert.equal((await c.post('/api/sync', up(it('a1')))).status, 401);
  assert.equal((await c.get('/api/account/export')).status, 401);
});

test('autorização: uma conta nunca vê, altera ou apaga dados de outra (IDOR/BOLA)', async () => {
  const { a, b, db } = await two();
  assert.equal((await a.post('/api/sync', up(it('seg1', { titulo: 'Segredo da Ana' })))).status, 200);
  // Beto não enxerga
  assert.deepEqual((await b.get('/api/sync')).json.items, []);
  // Beto tenta apagar pelo id da Ana: nada acontece com os dados dela
  assert.equal((await b.post('/api/sync', { items: { delete: ['seg1'] } })).status, 200);
  assert.equal((await a.get('/api/sync')).json.items.length, 1);
  // Beto grava um item com o MESMO id: cria o dele, sem sobrescrever o da Ana
  await b.post('/api/sync', up(it('seg1', { titulo: 'Do Beto' })));
  assert.equal((await a.get('/api/sync')).json.items[0].titulo, 'Segredo da Ana');
  assert.equal((await b.get('/api/sync')).json.items[0].titulo, 'Do Beto');
  // parâmetros de identificação enviados pelo cliente são ignorados
  const r = await b.post('/api/sync', { userId: 'outro', user_id: 'outro', items: { upsert: [] } });
  assert.equal(r.status, 200);
  const r2 = await b.get('/api/sync?user=qualquer&userId=qualquer&id=seg1');
  assert.equal(r2.json.items[0].titulo, 'Do Beto');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
});

test('mass assignment: campos extras (admin, user_id, rev) são descartados', async () => {
  const { a, db } = await two();
  const r = await a.post('/api/sync', up(it('x1', { isAdmin: true, user_id: 'outro', rev: 999, role: 'admin', updated_at: 1 })));
  assert.equal(r.status, 200);
  const got = r.json.items[0];
  assert.deepEqual(Object.keys(got).sort(), ['data', 'feita', 'id', 'materia', 'obs', 'tipo', 'titulo']);
  assert.ok(r.json.rev < 10, 'o cliente não controla a revisão');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
});

test('validação no servidor: tipos, datas, tamanhos, ids e lote atômico', async () => {
  const { a } = await two();
  const bad = async (item, code) => {
    const r = await a.post('/api/sync', up(it('ok1'), item));    // o lote inteiro deve ser recusado
    assert.equal(r.status, 400, JSON.stringify(item).slice(0, 80));
    if (code) assert.equal(r.json.error, code);
  };
  await bad(it('t1', { tipo: 'admin' }), 'invalid_tipo');
  await bad(it('t2', { data: '2026-02-30' }), 'invalid_data');
  await bad(it('t3', { data: '20/10/2026' }), 'invalid_data');
  await bad(it('t4', { data: '1999-01-01' }), 'invalid_data');
  await bad(it('t5', { titulo: 'x'.repeat(121) }), 'invalid_titulo');
  await bad(it('t6', { titulo: '' }), 'invalid_titulo');
  await bad(it('t7', { titulo: 'a\u0000b' }), 'invalid_titulo');
  await bad(it('t8', { titulo: 'linha\nquebrada' }), 'invalid_titulo');
  await bad(it('t9', { obs: 'y'.repeat(301) }), 'invalid_obs');
  await bad(it('../etc/passwd'), 'invalid_id');
  await bad(it("a'; DROP TABLE items;--"), 'invalid_id');
  await bad(it('t10', { titulo: 123 }), 'invalid_titulo');
  await bad(it('t11', { materia: 'z'.repeat(41) }), 'invalid_materia');
  await bad(it('t12', { feita: true, feitaEm: 'ontem' }), 'invalid_feitaEm');
  await bad(it('ok1'), 'duplicate_id');
  assert.deepEqual((await a.get('/api/sync')).json.items, [], 'nada do lote recusado foi gravado');
  assert.equal((await a.post('/api/sync', [])).status, 400);
  assert.equal((await a.post('/api/sync', { items: 'x' })).status, 400);
  assert.equal((await a.post('/api/sync', { items: { upsert: new Array(1001).fill(0).map((_, i) => it('l' + i)) } })).status, 400);
});

test('matérias: notas dentro do limite e itens por matéria', async () => {
  const { a } = await two();
  const m = (comps) => ({ materias: { upsert: [{ id: 'm1', nome: 'Matemática', comps }] } });
  assert.equal((await a.post('/api/sync', m([{ id: 'c1', nome: 'Prova', max: 4, tirei: 5 }]))).status, 400, 'nota acima do máximo');
  assert.equal((await a.post('/api/sync', m([{ id: 'c1', nome: 'Prova', max: -1 }]))).status, 400);
  assert.equal((await a.post('/api/sync', m([{ id: 'c1', nome: 'A', max: 2 }, { id: 'c1', nome: 'B', max: 2 }]))).status, 400, 'ids repetidos');
  assert.equal((await a.post('/api/sync', m(new Array(31).fill(0).map((_, i) => ({ id: 'c' + i, nome: 'n', max: 1}))))).status, 400);
  const ok = await a.post('/api/sync', m([{ id: 'c1', nome: 'Caderno', max: 2, tirei: 1.5 }, { id: 'c2', nome: 'Prova', max: 4, tirei: null }]));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.materias[0].comps[0].tirei, 1.5);
});

test('novos tipos de atividade são aceitos e injeção SQL/HTML é guardada como texto', async () => {
  const { a, db } = await two();
  const payloads = ["'); DROP TABLE items;--", '<script>alert(1)</script>', '${7*7}', '{{constructor}}'];
  const items = ['prova', 'teste', 'apresentacao', 'seminario', 'entrega', 'tarefa'].map((t, i) => it('n' + i, { tipo: t, titulo: payloads[i % 4] }));
  const r = await a.post('/api/sync', up(...items));
  assert.equal(r.status, 200);
  assert.equal(r.json.items.length, 6);
  assert.ok(r.json.items.some((x) => x.titulo === payloads[1]), 'texto guardado sem alteração');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 6, 'a tabela continua existindo');
  assert.match(r.headers.get('content-type'), /application\/json/);
});

test('__proto__ no JSON não contamina objetos', async () => {
  const { a } = await two();
  const raw = '{"items":{"upsert":[{"id":"p1","titulo":"t","materia":"m","tipo":"tarefa","data":"2026-10-20","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}]}}';
  const r = await a.req('POST', '/api/sync', undefined, { raw, headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal({}.polluted, undefined);
  assert.equal(r.json.items[0].polluted, undefined);
});

test('limite de itens por conta: o lote que passa do limite é desfeito por inteiro', async () => {
  const { a } = await two();
  for (let b = 0; b < 5; b++) {
    const r = await a.post('/api/sync', up(...new Array(1000).fill(0).map((_, i) => it(`b${b}x${i}`))));
    assert.equal(r.status, 200);
  }
  const over = await a.post('/api/sync', up(it('mais1')));
  assert.equal(over.status, 422);
  assert.equal(over.json.error, 'limit_exceeded');
  assert.equal((await a.get('/api/sync')).json.items.length, 5000);
});

test('revisão aumenta a cada gravação e apagar funciona', async () => {
  const { a } = await two();
  const r1 = await a.post('/api/sync', up(it('r1')));
  const r2 = await a.post('/api/sync', { items: { upsert: [it('r1', { feita: true })] } });
  assert.equal(r2.json.rev, r1.json.rev + 1);
  assert.equal(r2.json.items[0].feita, true);
  assert.equal(r2.json.items[0].feitaEm, '2026-10-20');
  const r3 = await a.post('/api/sync', { items: { delete: ['r1'] } });
  assert.deepEqual(r3.json.items, []);
});

test('servidor sem PEPPER (ou com o texto de exemplo) recusa tudo em vez de funcionar de forma insegura', async () => {
  for (const pepper of [undefined, '', 'curto', 'troque-por-um-texto-aleatorio-com-pelo-menos-32-caracteres']) {
    const { env } = makeEnv({ PEPPER: pepper });
    const c = makeClient(env);
    const r = await c.post('/api/auth/register', { email: 'a@example.com', password: 'Correct-Horse-Battery-9', acceptTerms: true, confirmAge: true });
    assert.equal(r.status, 503, String(pepper));
    assert.equal(r.json.error, 'server_misconfigured');
    assert.equal((await c.get('/api/auth/me')).status, 503);
  }
});
