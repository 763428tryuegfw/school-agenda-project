import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigest, digestLines, digestMessage, localNow, validTimeZone, dayDiff, addDaysISO, dowOf, fmtDia, isAvaliativo, TIPOS } from '../public/digest.js';

const it = (titulo, tipo, data, o = {}) => ({ titulo, materia: o.materia || 'Matemática', tipo, data, feita: !!o.feita });
const TODAY = '2026-10-18';                                     // domingo

test('datas: diferença, soma de dias, dia da semana (mês, ano e bissexto)', () => {
  assert.equal(dayDiff('2028-03-01', '2028-02-28'), 2);          // 2028 é bissexto
  assert.equal(dayDiff('2027-03-01', '2027-02-28'), 1);
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28');
  assert.equal(dowOf('2026-10-18'), 0);
  assert.equal(fmtDia('2026-10-21'), '21/10 (qua)');
});

test('fuso horário: hora e dia locais corretos, meia-noite é 0 e não 24', () => {
  assert.deepEqual(localNow('America/Sao_Paulo', Date.UTC(2026, 9, 18, 2, 30)), { day: '2026-10-17', hour: 23 });
  assert.deepEqual(localNow('America/Sao_Paulo', Date.UTC(2026, 9, 18, 3, 0)), { day: '2026-10-18', hour: 0 });
  assert.deepEqual(localNow('Asia/Tokyo', Date.UTC(2026, 9, 18, 2, 30)), { day: '2026-10-18', hour: 11 });
  assert.deepEqual(localNow('UTC', Date.UTC(2026, 11, 31, 23, 59)), { day: '2026-12-31', hour: 23 });
  assert.equal(validTimeZone('America/Sao_Paulo'), true);
  for (const bad of ['Marte/Phobos', '', 'x'.repeat(65), 123, null, undefined, '<script>']) assert.equal(validTimeZone(bad), false, String(bad));
});

test('"perto do prazo": hoje a 3 dias entra; 4 dias não; atrasadas separadas; feitas ficam de fora', () => {
  const dg = buildDigest([
    it('atrasada', 'tarefa', '2026-10-17'),
    it('hoje', 'tarefa', '2026-10-18'),
    it('em3', 'tarefa', '2026-10-21'),
    it('em4', 'tarefa', '2026-10-22'),
    it('feita-atrasada', 'tarefa', '2026-10-10', { feita: true }),
    it('feita-hoje', 'tarefa', '2026-10-18', { feita: true }),
  ], TODAY);
  assert.deepEqual(dg.atrasadas.map((x) => x.i.titulo), ['atrasada']);
  assert.deepEqual(dg.perto.map((x) => x.i.titulo), ['hoje', 'em3']);
});

test('"faltam para fechar a semana": semana de domingo a sábado', () => {
  // domingo 18: a semana vai até sábado 24
  let dg = buildDigest([it('a', 'tarefa', '2026-10-18'), it('b', 'tarefa', '2026-10-24'), it('c', 'tarefa', '2026-10-25'), it('d', 'tarefa', '2026-10-20', { feita: true }), it('e', 'tarefa', '2026-10-17')], TODAY);
  assert.deepEqual(dg.semana, { faltam: 2, total: 3, feitas: 1 });        // c (dia 25) é da próxima semana e e (dia 17) da passada
  // quarta 21: semana de 18 a 24; só faltam os dias de hoje até sábado
  dg = buildDigest([it('a', 'tarefa', '2026-10-21'), it('b', 'tarefa', '2026-10-24'), it('c', 'tarefa', '2026-10-19', { feita: true }), it('d', 'tarefa', '2026-10-20')], '2026-10-21');
  assert.deepEqual(dg.semana, { faltam: 2, total: 4, feitas: 1 });
  // sábado 24: a semana termina hoje
  dg = buildDigest([it('a', 'tarefa', '2026-10-24'), it('b', 'tarefa', '2026-10-25')], '2026-10-24');
  assert.equal(dg.semana.faltam, 1);
});

test('"dia X é prova / apresentação / teste / seminário": só avaliativos, até 14 dias', () => {
  const dg = buildDigest([
    it('P', 'prova', '2026-10-21', { materia: 'Matemática' }),
    it('A', 'apresentacao', '2026-10-23', { materia: 'História' }),
    it('T', 'teste', '2026-10-22', { materia: 'Inglês' }),
    it('S', 'seminario', '2026-10-25', { materia: 'Geografia' }),
    it('E', 'entrega', '2026-10-20'),
    it('X', 'tarefa', '2026-10-20'),
    it('limite', 'prova', '2026-11-01', { materia: 'Física' }),        // +14: entra
    it('longe', 'prova', '2026-11-02', { materia: 'Química' }),        // +15: fora
    it('feito', 'prova', '2026-10-19', { materia: 'Artes', feita: true }),
  ], TODAY);
  assert.deepEqual(dg.eventos.map((x) => x.i.titulo), ['P', 'T', 'A', 'S', 'limite']);
  const ev = digestLines(dg).find((l) => l.kind === 'evento').text;
  assert.equal(ev, 'Dia 21/10 (qua) é prova de Matemática; dia 22/10 (qui) é teste de Inglês; dia 23/10 (sex) é apresentação de História; dia 25/10 (dom) é seminário de Geografia; e mais 1.');
});

test('frases: plural/singular e resumo da semana', () => {
  const um = digestLines(buildDigest([it('a', 'tarefa', '2026-10-10')], TODAY));
  assert.equal(um[0].text, '1 atividade atrasada.');
  const dois = digestLines(buildDigest([it('a', 'tarefa', '2026-10-10'), it('b', 'tarefa', '2026-10-11')], TODAY));
  assert.equal(dois[0].text, '2 atividades atrasadas.');
  const sem = digestLines(buildDigest([it('a', 'tarefa', '2026-10-20'), it('b', 'tarefa', '2026-10-21', { feita: true })], TODAY)).find((l) => l.kind === 'semana');
  assert.equal(sem.text, 'Faltam 1 atividade para fechar a semana (1 de 2 já feitas).');
  const perto = digestLines(buildDigest([it('Lista 4', 'tarefa', '2026-10-19', { materia: 'Física' })], TODAY)).find((l) => l.kind === 'prazo').text;
  assert.equal(perto, 'Perto do prazo — Amanhã: Lista 4 (Física).');
});

test('mensagem: título dá prioridade a avaliação de hoje/amanhã e é nula sem nada a avisar', () => {
  assert.equal(digestMessage(buildDigest([], TODAY)), null);
  assert.equal(digestMessage(buildDigest([it('a', 'tarefa', '2027-01-01'), it('b', 'tarefa', '2026-10-10', { feita: true })], TODAY)), null);
  const hoje = digestMessage(buildDigest([it('a', 'tarefa', '2026-10-10'), it('p', 'prova', '2026-10-18', { materia: 'Biologia' }), it('t', 'teste', '2026-10-19')], TODAY));
  assert.equal(hoje.title, 'Agenda Escolar · Hoje: prova de Biologia');
  const amanha = digestMessage(buildDigest([it('a', 'tarefa', '2026-10-10'), it('t', 'seminario', '2026-10-19', { materia: 'Artes' })], TODAY));
  assert.equal(amanha.title, 'Agenda Escolar · Amanhã: seminário de Artes');
  assert.equal(digestMessage(buildDigest([it('a', 'tarefa', '2026-10-10')], TODAY)).title, 'Agenda Escolar · 1 atividade atrasada');
  assert.equal(digestMessage(buildDigest([it('a', 'tarefa', '2026-10-20')], TODAY)).title, 'Agenda Escolar · 1 prazo perto');
  assert.equal(digestMessage(buildDigest([it('a', 'prova', '2026-10-30', { materia: 'Física' })], TODAY)).title, 'Agenda Escolar · Próxima data: prova de Física');
  assert.equal(digestMessage(buildDigest([it('a', 'tarefa', '2026-10-23'), it('b', 'tarefa', '2026-10-24')], TODAY)).title, 'Agenda Escolar · Faltam 2 atividades na semana');
});

test('mensagem: textos longos são cortados e o corpo nunca passa de 700 caracteres', () => {
  const longo = 'x'.repeat(300);
  const items = Array.from({ length: 30 }, (_, i) => it(longo + i, 'prova', `2026-10-${19 + (i % 8)}`, { materia: longo }));
  const m = digestMessage(buildDigest(items, TODAY));
  assert.ok(m.body.length <= 700);
  assert.ok(m.title.length < 90);
  assert.match(m.body, /…/);
});

test('todo tipo de atividade tem rótulo e os avaliativos são exatamente os quatro pedidos', () => {
  assert.deepEqual(Object.keys(TIPOS).sort(), ['apresentacao', 'entrega', 'prova', 'seminario', 'tarefa', 'teste']);
  assert.deepEqual(Object.keys(TIPOS).filter(isAvaliativo).sort(), ['apresentacao', 'prova', 'seminario', 'teste']);
});
