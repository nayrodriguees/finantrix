// Finantrix — interpretador local de linguagem natural (pt-BR).
// Funciona 100% offline. Quando há chave da Claude configurada, ai.js é usado primeiro.
import { iso, today, addDays, addMonths, daysIn, WEEKDAYS, kindOfCategory } from './core.js';

export const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

const NUM_WORDS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600,
  setecentos: 700, oitocentos: 800, novecentos: 900, mil: 1000, primeiro: 1
};
// "cento e cinquenta e dois" -> 152 ; "dois mil e trezentos" -> 2300
function wordsToNumber(str) {
  const toks = str.split(/\s+/).filter(t => t !== 'e');
  if (!toks.length || !toks.every(t => t in NUM_WORDS)) return null;
  let total = 0, cur = 0;
  for (const t of toks) { const v = NUM_WORDS[t]; if (v === 1000) { total += (cur || 1) * 1000; cur = 0; } else cur += v; }
  return total + cur;
}
// Converte números por extenso em dígitos dentro do texto normalizado.
function digitize(t) {
  const words = Object.keys(NUM_WORDS).filter(w => w !== 'primeiro' && w !== 'um' && w !== 'uma').join('|');
  const re = new RegExp(`\\b((?:${words})(?:\\s+(?:e\\s+)?(?:${words}|um|uma))*)\\b`, 'g');
  return t.replace(re, m => { const n = wordsToNumber(m); return n == null ? m : String(n); })
          .replace(/\bdia (um|primeiro)\b/g, 'dia 1');
}

const BILL_CATS = [
  ['energia', /\b(energia|luz|eletricidade|enel|cemig|copel|light|celesc|coelba|cpfl|equatorial|neoenergia|celpe|cosern|elektro)\b/, 'Energia'],
  ['agua', /\b(agua|saneamento|sabesp|cedae|copasa|sanepar|embasa|compesa|caesb|esgoto)\b/, 'Água'],
  ['internet', /\b(internet|wi-?fi|banda larga|fibra|vivo fibra|claro net|net virtua|oi fibra)\b/, 'Internet'],
  ['telefone', /\b(celular|telefone|plano do celular|tim|vivo|claro|oi)\b/, 'Telefone'],
  ['gas', /\b(gas|botijao|comgas|naturgy)\b/, 'Gás'],
  ['moradia', /\b(aluguel|condominio|financiamento da casa|financiamento do apartamento|prestacao da casa)\b/, null],
  ['cartao', /\b(cartao|fatura|nubank|itaucard|credicard|inter|c6)\b/, null],
  ['impostos', /\b(iptu|ipva|imposto|das|mei|darf|irpf|licenciamento|multa)\b/, null],
  ['assinatura', /\b(netflix|spotify|disney|amazon prime|prime video|hbo|max|globoplay|youtube premium|assinatura|deezer|icloud|google one|chatgpt|claude)\b/, null],
  ['educacao', /\b(escola|faculdade|curso|mensalidade escolar|material escolar|universidade|ingles)\b/, null],
  ['saudeplano', /\b(plano de saude|unimed|amil|bradesco saude|sulamerica|seguro|hapvida|odontologico)\b/, null],
  ['transporte', /\b(carro|combustivel|gasolina|estacionamento|uber|onibus|parcela do carro)\b/, null],
  ['financeiro', /\b(emprestimo|consignado|financiamento|parcela|divida|acordo)\b/, null],
];
const EVENT_CATS = [
  // Compromissos (sair de casa / consultas)
  ['saude', /\b(medico|medica|consulta|dentista|exame|exames|clinica|hospital|terapia|psicolog\w*|fisioterapia|vacina|cardiologista|dermatologista|ginecologista|oftalmologista|pediatra|nutricionista|academia|personal|laboratorio|retorno)\b/],
  ['compras', /\b(mercado|supermercado|farmacia|feira|shopping|loja|comprar|compras|acougue|padaria)\b/],
  ['social', /\b(aniversario|festa|casamento|jantar|almoco|churrasco|encontro|show|cinema|viagem|voo|batizado|formatura|teatro|restaurante)\b/],
  ['externo', /\b(banco|cartorio|correios|detran|poupatempo|oficina|revisao|salao|cabeleireiro|manicure|barbeiro|buscar|levar|ir (a|ao|na|no|para|pra|pro)|passar (na|no)|sair|consulado|prefeitura|lavanderia|veterinario|pet ?shop|escola|igreja|vistoria|entrevista)\b/],
  // Tarefas
  ['trabalho', /\b(reuniao|call|cliente|apresentacao|projeto|entrega|prazo|trabalho|meeting|webinar|treinamento|relatorio|planilha|proposta|e-?mails?|responder|orcamento|post|conteudo|planejamento)\b/],
  ['casa', /\b(limpar|lavar|arrumar|consertar|faxina|manutencao|regar|lixo|passar roupa|organizar|cozinhar)\b/],
];
const BILL_HINT = /\b(conta|contas|boleto|pagar|pagamento|fatura|vencimento|vence|mensalidade|parcela|prestacao|debito|pix|reais|r\$)\b/;
const EVENT_HINT = /\b(consulta|medico|dentista|reuniao|exame|aniversario|compromisso|evento|encontro|entrevista|viagem|voo|aula|festa|jantar|almoco)\b/;
const PAY_INTENT = /\b(ja paguei|paguei|foi pag[oa]|esta pag[oa]|ta pag[oa]|quitei|quitada|marca(r)? (como )?pag[oa]|confirm\w* (o )?pagamento|dei baixa|baixa n[ao])\b/;
const DONE_INTENT = /\b(ja fiz|terminei|conclui|feito|finalizei|marca(r)? (como )?(feit[oa]|conclu\w+)|ja fui|ja foi feito)\b/;
const QUERY_INTENT = /^(o que|oque|quais|qual|quanto|quantas|quantos|tenho (?:algo|alguma|algum|compromisso|conta)|tem algo|me (diz|fala|mostra)|mostra|lista|resumo|como (esta|estao)|quando)\b|\?\s*$/;

const WD_MAP = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const MONTH_MAP = { janeiro: 0, fevereiro: 1, marco: 2, abril: 3, maio: 4, junho: 5, julho: 6, agosto: 7, setembro: 8, outubro: 9, novembro: 10, dezembro: 11 };

function nextDayOfMonth(day, base = today()) {
  let d = new Date(base.getFullYear(), base.getMonth(), Math.min(day, daysIn(base)));
  if (d < base) { const n = new Date(base.getFullYear(), base.getMonth() + 1, 1); d = new Date(n.getFullYear(), n.getMonth(), Math.min(day, daysIn(n))); }
  return d;
}
function nextWeekday(wd) {
  let d = addDays(today(), 1);
  while (d.getDay() !== wd) d = addDays(d, 1);
  return d;
}

// Extrai data, hora e recorrência. Retorna também os trechos usados (para limpar o título).
function extractWhen(t) {
  const used = [];
  const take = (re) => { const m = t.match(re); if (m) used.push(m[0]); return m; };
  let date = null, recurrence = null, time = null, m;

  // Recorrências
  if ((m = take(/\b(?:todo|todos os|toda) dias? (\d{1,2})(?: de (?:cada|todo) mes)?\b/)) || (m = take(/\bdia (\d{1,2}) de (?:todo|cada) mes\b/)) || (m = take(/\btodo (\d{1,2}) de cada mes\b/))) {
    recurrence = { type: 'monthly', day: Math.min(31, Math.max(1, Number(m[1]))) };
  } else if ((m = take(/\b(todo|toda) (mes|mensal(mente)?)\b|\bmensalmente\b/))) {
    const dm = t.match(/\bdia (\d{1,2})\b/); if (dm) used.push(dm[0]);
    recurrence = { type: 'monthly', day: dm ? Number(dm[1]) : today().getDate() };
  } else if ((m = take(/\b(toda|todas as|todo) (segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira|s?-feiras?|s)?\b/))) {
    recurrence = { type: 'weekly', weekday: WD_MAP[m[2]] };
  } else if ((m = take(/\b(toda semana|semanalmente)\b/))) {
    recurrence = { type: 'weekly', weekday: today().getDay() };
  } else if ((m = take(/\b(todo dia|todos os dias|diariamente|diario)\b/))) {
    recurrence = { type: 'daily' };
  } else if ((m = take(/\b(todo ano|anualmente|todos os anos)\b/))) {
    recurrence = { type: 'yearly' };
  }

  // Datas
  if ((m = take(/\bdepois de amanha\b/))) date = addDays(today(), 2);
  else if ((m = take(/\bamanha\b/))) date = addDays(today(), 1);
  else if ((m = take(/\bhoje\b/))) date = today();
  else if ((m = take(/\b(?:(?:no |para o |pro )?dia )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    let y = m[3] ? Number(m[3]) : today().getFullYear(); if (y < 100) y += 2000;
    date = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && date < today()) date = new Date(y + 1, Number(m[2]) - 1, Number(m[1]));
  } else if ((m = take(/\b(?:dia )?(\d{1,2}) de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de (\d{4}))?\b/))) {
    let y = m[3] ? Number(m[3]) : today().getFullYear();
    date = new Date(y, MONTH_MAP[m[2]], Number(m[1]));
    if (!m[3] && date < today()) date = new Date(y + 1, MONTH_MAP[m[2]], Number(m[1]));
  } else if ((m = take(/\b(?:na |no |nessa |nesta |essa |esta )?(proxima |proximo )?(segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?( que vem)?\b/)) && !recurrence) {
    date = nextWeekday(WD_MAP[m[2]]);
  } else if ((m = take(/\b(?:em|daqui a|daqui)\s+(\d{1,3})\s+(dias?|semanas?|mes(?:es)?)\b/))) {
    const n = Number(m[1]);
    date = m[2].startsWith('dia') ? addDays(today(), n) : m[2].startsWith('semana') ? addDays(today(), n * 7) : addMonths(today(), n);
  } else if ((m = take(/\b(semana que vem|proxima semana)\b/))) {
    date = addDays(today(), 7);
  } else if ((m = take(/\b(fim|final) do mes\b/))) {
    const t0 = today(); date = new Date(t0.getFullYear(), t0.getMonth(), daysIn(t0));
  } else if ((m = take(/\b(mes que vem|proximo mes)\b/))) {
    const dm = t.match(/\bdia (\d{1,2})\b/);
    const n = addMonths(new Date(today().getFullYear(), today().getMonth(), 1), 1);
    if (dm) { used.push(dm[0]); date = new Date(n.getFullYear(), n.getMonth(), Math.min(Number(dm[1]), daysIn(n))); }
    else date = new Date(n.getFullYear(), n.getMonth(), Math.min(today().getDate(), daysIn(n)));
  } else if (!recurrence && (m = take(/\b(?:no |para o |pro |ate o |ate )?dia (\d{1,2})\b/))) {
    date = nextDayOfMonth(Number(m[1]));
  }
  if (recurrence && recurrence.type === 'yearly') {
    const d = date || today(); recurrence.month = d.getMonth(); recurrence.day = d.getDate();
  }
  if (recurrence && recurrence.type === 'weekly' && date) recurrence.weekday = date.getDay();

  // Horário
  if ((m = take(/\b(?:as |a partir das |ate as |por volta das )?(\d{1,2})(?::|h| horas? e |h)(\d{2})\b/))) time = [Number(m[1]), Number(m[2])];
  else if ((m = take(/\b(?:as |a partir das |por volta das )?(\d{1,2}) ?(?:h|horas?)\b(?: (da manha|da tarde|da noite))?/))) time = [Number(m[1]), 0, m[2]];
  else if ((m = take(/\bas (\d{1,2})(?: (da manha|da tarde|da noite))?\b/))) time = [Number(m[1]), 0, m[2]];
  else if ((m = take(/\b(meio[- ]dia)( e meia)?\b/))) time = [12, m[2] ? 30 : 0];
  else if ((m = take(/\bmeia[- ]noite\b/))) time = [0, 0];
  else if ((m = take(/\b(de|pela|na parte da) manha\b/))) time = [9, 0];
  else if ((m = take(/\b(de|a|pela|na parte da) tarde\b/))) time = [14, 0];
  else if ((m = take(/\b(de|a|pela) noite\b/))) time = [19, 0];
  if (time) {
    let [h, mi, per] = time;
    const p = per || (t.match(/\b(da manha|da tarde|da noite)\b/) || [])[1];
    if (p && !per) used.push(p);
    if (p && (p.includes('tarde') || p.includes('noite')) && h < 12) h += 12;
    if (/ e meia\b/.test(t) && mi === 0) { mi = 30; used.push('e meia'); }
    time = h <= 23 && mi <= 59 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
  }
  return { date: date ? iso(date) : null, time, recurrence, used };
}

function extractAmount(t) {
  let m = t.match(/r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/)
       || t.match(/\b(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:reais|real|conto|pila)\b(?:\s*e\s*(\d{1,2})\s*centavos)?/)
       || t.match(/\b(?:valor(?: de)?|de|custa|fica|ficou|deu)\s+(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+,\d{1,2})\b/);
  if (!m) return { amount: null, used: null };
  let s = m[1];
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(s) || /\.\d{3}\./.test(s)) s = s.replace(/\./g, '');
  let v = parseFloat(s);
  if (m[2]) v += Number(m[2]) / 100;
  return { amount: isFinite(v) ? Math.round(v * 100) / 100 : null, used: m[0] };
}

const FILLER = /\b(me|oi|ola|ei|secretaria|finantrix|por favor|pfv|anota(r)?( ai)?|anote|agenda(r)?|marca(r)?|coloca(r)?|lembra(r)?( de| que)?|me lembr\w*( de| que)?|lembrete( de)?|preciso( de)?|tenho que|tenho|eu tenho|vou ter|eu vou|vou|eu|cadastra(r)?|adiciona(r)?|registra(r)?|salva(r)?|cria(r)?|que|uma?|o|a|os|as|de|do|da|no|na|para|pra|pro|com|vence|vencimento|valor|e|tambem|ai|ta|ok|beleza|certo|nao esquecer( de)?|esquecer)\b/g;

function cleanTitle(original, used) {
  let t = digitize(norm(original));
  for (const u of used.filter(Boolean).sort((a, b) => b.length - a.length)) t = t.replace(u, ' ');
  t = t.replace(/r\$\s*[\d.,]+/g, ' ').replace(/\b\d+[.,]?\d*\s*(reais|real)\b/g, ' ').replace(/[.,!?;:]+/g, ' ');
  const words = t.split(' ').filter(Boolean);
  // remove palavras de preenchimento apenas nas pontas e conectivos soltos
  const isFill = w => new RegExp(`^(${FILLER.source.slice(3, -3)})$`).test(w);
  while (words.length && isFill(words[0])) words.shift();
  while (words.length && isFill(words[words.length - 1])) words.pop();
  let out = words.join(' ').replace(/\b(as|às|a)\s*$/, '').trim();
  // restaura acentos usando o texto original quando possível
  const origWords = original.replace(/[.,!?;:]+/g, ' ').split(/\s+/);
  out = out.split(' ').map(w => origWords.find(o => norm(o) === w) || w).join(' ');
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}

function splitSentences(text) {
  return text.split(/(?:(?<!\d)[.;]+(?!\d)\s*|\n+|\s+e tambem\s+|\s+tambem\s+(?=(?:tenho|preciso|anota|lembra|marca|coloca)\b)|\s+e depois\s+|\s+alem disso\s+)/i)
             .map(s => s.trim()).filter(s => s.length > 2);
}

export function parseOne(raw) {
  const t = digitize(norm(raw));
  const when = extractWhen(t);
  const { amount, used: amtUsed } = extractAmount(t);

  let kind = 'task', category = 'tarefa', fixedTitle = null;
  for (const [k, re, title] of BILL_CATS) { const mm = t.match(re); if (mm && (BILL_HINT.test(t) || amount != null || title)) { kind = 'bill'; category = k; fixedTitle = title; break; } }
  if (kind === 'task' && (BILL_HINT.test(t) && (amount != null || /\b(conta|boleto|fatura|pagar)\b/.test(t)))) { kind = 'bill'; category = 'outros'; }
  if (kind !== 'bill') {
    for (const [k, re] of EVENT_CATS) if (re.test(t)) { category = k; kind = kindOfCategory(k); break; }
  }

  let title = cleanTitle(raw, [...when.used, amtUsed]);
  if (kind === 'bill' && fixedTitle === null) { const mm = BILL_CATS.find(b => b[0] === category); const hit = mm && t.match(mm[1]); if (hit && (!title || norm(title).split(' ').length > 4)) title = hit[0]; }
  if (kind === 'bill') {
    for (let k = 0; k < 3; k++) title = title.replace(/^(pagar|pagamento|conta|boleto|fatura)(\s+(de|da|do))?\s+/i, '').replace(/^(a|o|as|os)\s+/i, '');
    if (fixedTitle && (!title || norm(title).split(' ').length <= 2)) title = fixedTitle;
    title = title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Conta';
  }
  if (!title) title = kind === 'event' ? 'Compromisso' : 'Tarefa';

  let date = when.date;
  if (!date && !when.recurrence) date = kind === 'bill' ? null : iso(today());
  if (when.recurrence && when.recurrence.type === 'monthly' && !date) date = iso(nextDayOfMonth(when.recurrence.day));

  return {
    kind, title, category,
    date, time: when.time, recurrence: when.recurrence,
    amount: kind === 'bill' ? amount : null,
    notes: '', source: raw, missing: kind === 'bill' && !date && !when.recurrence ? ['date'] : []
  };
}

// Interpreta a fala completa e decide a intenção.
export function interpret(text, items = []) {
  const t = digitize(norm(text));
  if (PAY_INTENT.test(t) || DONE_INTENT.test(t)) {
    const target = findItem(t, items, PAY_INTENT.test(t) ? 'bill' : null);
    const a = extractAmount(t).amount ?? (t.match(/\b(\d+(?:,\d{1,2})?)\s*$/) ? parseFloat(t.match(/\b(\d+(?:,\d{1,2})?)\s*$/)[1].replace(',', '.')) : null);
    return { intent: PAY_INTENT.test(t) ? 'pay' : 'complete', target, amount: a, text };
  }
  if (QUERY_INTENT.test(t) && !/\b(anota|lembra|marca|agenda|coloca|cadastra|adiciona)\b/.test(t)) {
    return { intent: 'query', query: parseQuery(t), text };
  }
  return { intent: 'create', items: splitSentences(text).map(parseOne), text };
}

function parseQuery(t) {
  const w = extractWhen(t);
  let scope = 'week';
  if (/\bhoje\b/.test(t)) scope = 'today';
  else if (/\bamanha\b/.test(t)) scope = 'tomorrow';
  else if (/\b(mes|mensal)\b/.test(t)) scope = 'month';
  else if (/\b(semana)\b/.test(t)) scope = 'week';
  else if (w.date) scope = 'date';
  const topic = /\b(pagar|conta|boleto|pendente|vencid|gast|financ|devendo|quanto)\w*/.test(t) ? 'bills'
              : /\b(compromisso|agenda|medico|reuniao|consulta|evento)\w*/.test(t) ? 'events' : 'all';
  return { scope, topic, date: w.date, overdue: /\bvencid|atrasad/.test(t) };
}

export function findItem(t, items, kind) {
  const words = t.split(' ').filter(w => w.length > 2 && !/^(ja|paguei|pago|paga|foi|esta|conta|boleto|fatura|marca|como|que|dei|baixa|terminei|fiz|feito|conclui)$/.test(w));
  let best = null, bestScore = 0;
  for (const it of items) {
    if (kind && it.kind !== kind) continue;
    const hay = norm(`${it.title} ${it.category} ${(BILL_CATS.find(b => b[0] === it.category) || [])[2] || ''}`);
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length;
    const catRe = (BILL_CATS.find(b => b[0] === it.category) || [])[1];
    if (catRe && catRe.test(t)) score += 6;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore >= 3 ? best : null;
}

export { WEEKDAYS };
