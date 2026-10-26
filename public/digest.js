// Resumo de avisos. É o MESMO arquivo no navegador (avisos dentro do app e notificações locais)
// e no servidor (notificações push enviadas pelo agendamento diário). Funções puras, sem DOM.

export const TIPOS = {
  tarefa: 'Tarefa',
  entrega: 'Entrega',
  prova: 'Prova',
  teste: 'Teste',
  apresentacao: 'Apresentação',
  seminario: 'Seminário',
};
// Tipos que são "dia marcado" (avaliações e apresentações)
export const AVALIATIVOS = ['prova', 'teste', 'apresentacao', 'seminario'];
export const NOME_FRASE = { prova: 'prova', teste: 'teste', apresentacao: 'apresentação', seminario: 'seminário', entrega: 'entrega', tarefa: 'tarefa' };
const DIA3 = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export const isAvaliativo = (tipo) => AVALIATIVOS.includes(tipo);
export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

const toDays = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 864e5); };
export const dayDiff = (a, b) => toDays(a) - toDays(b);
export const addDaysISO = (s, n) => new Date((toDays(s) + n) * 864e5).toISOString().slice(0, 10);
export const dowOf = (s) => new Date(toDays(s) * 864e5).getUTCDay();

/** Data e hora "de parede" em um fuso (ex.: America/Sao_Paulo) a partir de um instante UTC. */
export function localNow(tz, nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;
const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
export const fmtDia = (iso) => { const [, m, d] = iso.split('-'); return `${d}/${m} (${DIA3[dowOf(iso)]})`; };
const relTxt = (d) => (d === 0 ? 'Hoje' : d === 1 ? 'Amanhã' : `Em ${d} dias`);

/**
 * @param {Array} items  atividades ({titulo, materia, tipo, data, feita})
 * @param {string} today dia atual "AAAA-MM-DD" no fuso do usuário
 */
export function buildDigest(items, today) {
  const pend = items.filter((i) => !i.feita).map((i) => ({ i, d: dayDiff(i.data, today) }));
  const sat = 6 - dowOf(today);              // dias até o sábado (a semana do app vai de domingo a sábado)
  const weekStart = addDaysISO(today, -dowOf(today));
  const weekEnd = addDaysISO(today, sat);
  const doSem = items.filter((i) => i.data >= weekStart && i.data <= weekEnd);
  const byDate = (a, b) => a.d - b.d || a.i.titulo.localeCompare(b.i.titulo, 'pt-BR');
  return {
    today,
    atrasadas: pend.filter((x) => x.d < 0).sort(byDate),
    perto: pend.filter((x) => x.d >= 0 && x.d <= 3).sort(byDate),
    semana: {
      faltam: pend.filter((x) => x.d >= 0 && x.d <= sat).length,
      total: doSem.length,
      feitas: doSem.filter((i) => i.feita).length,
    },
    eventos: pend.filter((x) => x.d >= 0 && x.d <= 14 && isAvaliativo(x.i.tipo)).sort(byDate),
  };
}

/** Frases do resumo (usadas no app e na notificação). */
export function digestLines(dg) {
  const lines = [];
  if (dg.atrasadas.length) lines.push({ kind: 'atrasada', text: `${plural(dg.atrasadas.length, 'atividade atrasada', 'atividades atrasadas')}.` });
  if (dg.perto.length) {
    const parts = dg.perto.slice(0, 3).map((x) => `${relTxt(x.d)}: ${cut(x.i.titulo, 45)} (${cut(x.i.materia, 20)})`);
    const extra = dg.perto.length - 3;
    lines.push({ kind: 'prazo', text: `Perto do prazo — ${parts.join('; ')}${extra > 0 ? `; e mais ${extra}` : ''}.` });
  }
  if (dg.semana.faltam > 0) {
    lines.push({ kind: 'semana', text: `Faltam ${plural(dg.semana.faltam, 'atividade', 'atividades')} para fechar a semana (${dg.semana.feitas} de ${dg.semana.total} já feitas).` });
  }
  if (dg.eventos.length) {
    const ev = dg.eventos.slice(0, 4).map((x) => `dia ${fmtDia(x.i.data)} é ${NOME_FRASE[x.i.tipo]} de ${cut(x.i.materia, 24)}`);
    const extra = dg.eventos.length - 4;
    let t = ev.join('; ');
    t = t.charAt(0).toUpperCase() + t.slice(1);
    lines.push({ kind: 'evento', text: `${t}${extra > 0 ? `; e mais ${extra}` : ''}.` });
  }
  return lines;
}

/** Texto da notificação, ou null se não há nada relevante para avisar. */
export function digestMessage(dg) {
  const lines = digestLines(dg);
  if (!lines.length) return null;
  const hojeAval = dg.eventos.find((x) => x.d === 0);
  const amanhaAval = dg.eventos.find((x) => x.d === 1);
  let title;
  if (hojeAval) title = `Hoje: ${NOME_FRASE[hojeAval.i.tipo]} de ${cut(hojeAval.i.materia, 24)}`;
  else if (amanhaAval) title = `Amanhã: ${NOME_FRASE[amanhaAval.i.tipo]} de ${cut(amanhaAval.i.materia, 24)}`;
  else if (dg.atrasadas.length) title = plural(dg.atrasadas.length, 'atividade atrasada', 'atividades atrasadas');
  else if (dg.perto.length) title = plural(dg.perto.length, 'prazo perto', 'prazos perto');
  else if (dg.eventos.length) title = `Próxima data: ${NOME_FRASE[dg.eventos[0].i.tipo]} de ${cut(dg.eventos[0].i.materia, 24)}`;
  else title = `Faltam ${plural(dg.semana.faltam, 'atividade', 'atividades')} na semana`;
  let body = lines.map((l) => l.text).join(' ');
  if (body.length > 700) body = body.slice(0, 699).trimEnd() + '…';
  return { title: `Agenda Escolar · ${title}`, body, lines };
}
