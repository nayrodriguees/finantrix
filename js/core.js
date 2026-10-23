// Finantrix — regras de datas, recorrências e status.
export const pad = n => String(n).padStart(2, '0');
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMonths = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth() + n, 1); x.setDate(Math.min(d.getDate(), daysIn(x))); return x; };
export const daysIn = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
export const diffDays = (a, b) => Math.round((parseISO(iso(a)) - parseISO(iso(b))) / 86400000);
export const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const WD_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const fmtDate = (d, opts = { day: '2-digit', month: 'short' }) => (typeof d === 'string' ? parseISO(d) : d).toLocaleDateString('pt-BR', opts).replace('.', '');

export function relDay(d) {
  const n = diffDays(typeof d === 'string' ? parseISO(d) : d, today());
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  if (n === -1) return 'ontem';
  if (n > 1 && n < 7) return WEEKDAYS[(typeof d === 'string' ? parseISO(d) : d).getDay()];
  if (n < 0) return `há ${-n} dias`;
  return `em ${n} dias`;
}

export const CATEGORIES = {
  energia:   { label: 'Energia',      icon: 'bolt',    color: '#FFEE32', kind: 'bill' },
  agua:      { label: 'Água',         icon: 'drop',    color: '#5ce1ff', kind: 'bill' },
  internet:  { label: 'Internet',     icon: 'wifi',    color: '#8b7bff', kind: 'bill' },
  telefone:  { label: 'Telefone',     icon: 'phone',   color: '#8b7bff', kind: 'bill' },
  gas:       { label: 'Gás',          icon: 'flame',   color: '#ff9f43', kind: 'bill' },
  moradia:   { label: 'Moradia',      icon: 'home',    color: '#3ef0a0', kind: 'bill' },
  cartao:    { label: 'Cartão',       icon: 'card',    color: '#ff6b9a', kind: 'bill' },
  impostos:  { label: 'Impostos',     icon: 'bank',    color: '#ff9f43', kind: 'bill' },
  assinatura:{ label: 'Assinaturas',  icon: 'play',    color: '#ff6b9a', kind: 'bill' },
  educacao:  { label: 'Educação',     icon: 'book',    color: '#5ce1ff', kind: 'bill' },
  saudeplano:{ label: 'Plano/Seguro', icon: 'shield',  color: '#3ef0a0', kind: 'bill' },
  transporte:{ label: 'Transporte',   icon: 'car',     color: '#c3c9d4', kind: 'bill' },
  financeiro:{ label: 'Empréstimos',  icon: 'bank',    color: '#ff4d6d', kind: 'bill' },
  outros:    { label: 'Outros',       icon: 'tag',     color: '#c3c9d4', kind: 'bill' },
  // Compromissos = consultas e tudo que exige sair de casa
  saude:     { label: 'Consultas / Saúde', icon: 'heart', color: '#ff4d6d', kind: 'event' },
  externo:   { label: 'Fora de casa',      icon: 'pin',   color: '#ff9f43', kind: 'event' },
  compras:   { label: 'Compras / Rua',     icon: 'bag',   color: '#ffb86b', kind: 'event' },
  social:    { label: 'Social / Eventos',  icon: 'cake',  color: '#ff6b9a', kind: 'event' },
  // Tarefas = trabalho e afazeres
  trabalho:  { label: 'Trabalho',          icon: 'brief', color: '#5ce1ff', kind: 'task' },
  casa:      { label: 'Casa',              icon: 'home',  color: '#3ef0a0', kind: 'task' },
  pessoal:   { label: 'Pessoal',           icon: 'user',  color: '#FFEE32', kind: 'task' },
  tarefa:    { label: 'Tarefa',            icon: 'check', color: '#c3c9d4', kind: 'task' },
};
export const cat = k => CATEGORIES[k] || CATEGORIES.outros;
// A categoria manda na aba: contas só em Contas, consultas/rua só em Compromissos, trabalho/afazeres só em Tarefas.
export const kindOfCategory = k => (CATEGORIES[k] || {}).kind || null;
export const DEFAULT_CAT = { bill: 'outros', event: 'externo', task: 'tarefa' };
export function normalizeKind(it) {
  const k = kindOfCategory(it.category);
  if (it.kind === 'bill') { if (k !== 'bill') it.category = DEFAULT_CAT.bill; return it; }
  if (k === 'bill' || !k) { it.category = DEFAULT_CAT[it.kind] || 'tarefa'; return it; }
  it.kind = k; return it;
}

export function describeRecurrence(r) {
  if (!r) return 'Única';
  if (r.type === 'daily') return 'Todo dia';
  if (r.type === 'weekly') return `Toda ${WEEKDAYS[r.weekday].replace('-feira', '')}`;
  if (r.type === 'monthly') return `Todo dia ${r.day}`;
  if (r.type === 'yearly') return `Todo ano em ${r.day}/${pad(r.month + 1)}`;
  return 'Única';
}

// Gera as ocorrências de um item entre duas datas (inclusive).
export function occurrences(item, from, to) {
  const out = [];
  const start = item.startDate ? parseISO(item.startDate) : null;
  const end = item.endDate ? parseISO(item.endDate) : null;
  const push = d => {
    if (d < from || d > to) return;
    if (start && d < start) return;
    if (end && d > end) return;
    const date = iso(d);
    if (item.skips && item.skips.includes(date)) return;
    out.push({ item, date, key: item.recurrence ? date : 'once' });
  };
  const r = item.recurrence;
  if (!r) { if (item.date) push(parseISO(item.date)); return out; }
  if (r.type === 'daily') { for (let d = new Date(from); d <= to; d = addDays(d, 1)) push(new Date(d)); }
  else if (r.type === 'weekly') {
    let d = new Date(from); while (d.getDay() !== r.weekday) d = addDays(d, 1);
    for (; d <= to; d = addDays(d, 7)) push(new Date(d));
  } else if (r.type === 'monthly') {
    for (let m = new Date(from.getFullYear(), from.getMonth(), 1); m <= to; m = new Date(m.getFullYear(), m.getMonth() + 1, 1))
      push(new Date(m.getFullYear(), m.getMonth(), Math.min(r.day, daysIn(m))));
  } else if (r.type === 'yearly') {
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      const m = new Date(y, r.month, 1); push(new Date(y, r.month, Math.min(r.day, daysIn(m))));
    }
  }
  return out;
}

export function allOccurrences(items, from, to) {
  return items.flatMap(it => occurrences(it, from, to)).sort((a, b) => (a.date + (a.item.time || '99')).localeCompare(b.date + (b.item.time || '99')));
}

export const isDone = occ => {
  const it = occ.item;
  if (it.kind === 'bill') return !!(it.payments && it.payments[occ.key]);
  return !!(it.completions && it.completions[occ.key]);
};
export const amountOf = occ => {
  const p = occ.item.payments && occ.item.payments[occ.key];
  if (p && p.amount != null) return Number(p.amount);
  if (occ.item.amounts && occ.item.amounts[occ.key] != null) return Number(occ.item.amounts[occ.key]);
  return Number(occ.item.amount) || 0;
};

// pending | soon | today | overdue | paid
export function status(occ) {
  if (isDone(occ)) return 'paid';
  const n = diffDays(parseISO(occ.date), today());
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  if (n <= 3) return 'soon';
  return 'pending';
}
export const STATUS_LABEL = { paid: 'Pago', overdue: 'Vencido', today: 'Vence hoje', soon: 'Vence em breve', pending: 'Pendente' };
export const TASK_STATUS_LABEL = { paid: 'Concluído', overdue: 'Atrasado', today: 'Hoje', soon: 'Em breve', pending: 'Agendado' };
