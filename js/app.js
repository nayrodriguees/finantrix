// Finantrix — aplicação principal.
import { db, uid } from './db.js';
import { MARK_PATH } from './mark-path.js';
import { icon } from './icons.js';
import {
  iso, parseISO, today, addDays, addMonths, daysIn, diffDays, monthKey, pad,
  WEEKDAYS, WD_SHORT, MONTHS, brl, fmtDate, relDay, CATEGORIES, cat, describeRecurrence,
  occurrences, allOccurrences, isDone, amountOf, status, STATUS_LABEL, TASK_STATUS_LABEL, normalizeKind, kindOfCategory, DEFAULT_CAT, baseOf
} from './core.js';
import { interpret, findItem } from './parser.js';
import { aiInterpret } from './ai.js';
import { tg, send as tgSendRaw, tgEsc, startPolling, sendDocument, downloadFile } from './telegram.js';
import { initSW, computeAlerts, fireAlerts, notifPermission, requestPermission, chime, speak } from './notify.js';

/* ------------------------------------------------------------------ estado */
const S = {
  items: [],
  settings: { name: '', dailyHour: '08:00', billDaysBefore: 3, minutesBefore: 30, sound: true, voiceReply: true, apiKey: '',
    tgToken: '', tgBot: '', tgChatId: '', tgDaily: true, tgDailyHour: '07:30', tgEvening: true, tgReminders: true },
  route: 'painel',
  agenda: { mode: 'mes', cursor: today(), sel: iso(today()), filter: 'all' },
  fin: { cursor: new Date(today().getFullYear(), today().getMonth(), 1), filter: 'all' },
  chat: [],
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fillIcons = (root = document) => $$('[data-icon]', root).forEach(el => { el.innerHTML = icon(el.dataset.icon, +(el.dataset.size || 20)); el.removeAttribute('data-icon'); });

async function loadAll() {
  S.items = await db.all('items');
  for (const it of S.items) { const before = it.kind + it.category; normalizeKind(it); if (before !== it.kind + it.category) await db.put('items', it); }
  const saved = await db.getSetting('settings', {});
  S.settings = { ...S.settings, ...saved };
  S.chat = await db.getSetting('chat', []);
}
async function saveItem(it) { it = baseOf(it); markDirty(); it.updatedAt = Date.now(); await db.put('items', it); const i = S.items.findIndex(x => x.id === it.id); if (i >= 0) S.items[i] = it; else S.items.push(it); }
async function deleteItem(id) { markDirty(); const it = S.items.find(x => x.id === id); if (it) for (const f of it.files || []) await db.del('files', f.id); await db.del('items', id); S.items = S.items.filter(x => x.id !== id); }
async function saveSettings() { await db.setSetting('settings', S.settings); }
async function saveChat() { S.chat = S.chat.slice(-60); await db.setSetting('chat', S.chat); }

/* ------------------------------------------------------------------ boot */
async function boot() {
  $('#boot-path').setAttribute('d', MARK_PATH);
  const log = $('#boot-log'), bar = $('.boot-bar span');
  const steps = ['Inicializando núcleo neural', 'Carregando cofre local criptografado', 'Sincronizando agenda e recorrências', 'Calibrando motor de alertas', 'Secretária virtual online'];
  const work = loadAll();
  for (let i = 0; i < steps.length; i++) { log.textContent = '› ' + steps[i]; bar.style.width = `${(i + 1) / steps.length * 100}%`; await sleep(360); }
  await work;
  await initSW();
  // Pede ao navegador para nunca apagar os dados do Finantrix sozinho (limpeza automática de espaço).
  try { if (navigator.storage && navigator.storage.persist) S.persisted = await navigator.storage.persisted() || await navigator.storage.persist(); } catch {}
  fillIcons();
  $('#app').hidden = false; $('#voice-fab').hidden = false;
  $('#boot').classList.add('out'); setTimeout(() => $('#boot').remove(), 700);
  bindChrome();
  particles();
  clock();
  if (!location.hash) location.hash = '#/painel';
  await route(true);
  tick();
  setInterval(tick, 30000);
  tgRestart();
  tgOfferRestore();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}

/* ------------------------------------------------------------------ IA working overlay */
let aiBusy = 0;
async function aiWork(steps, total = 900, title = 'IA Finantrix processando') {
  const ov = $('#ai-overlay'); aiBusy++;
  $('#ai-ov-title').textContent = title;
  ov.hidden = false;
  const per = total / steps.length;
  for (let i = 0; i < steps.length; i++) {
    $('#ai-ov-step').textContent = '› ' + steps[i];
    $('#ai-ov-bar').style.width = `${(i + 1) / steps.length * 100}%`;
    await sleep(per);
  }
  if (--aiBusy === 0) { ov.hidden = true; $('#ai-ov-bar').style.width = '0'; }
}
// Mantém o overlay ligado enquanto uma promessa roda.
async function aiWhile(promise, steps, title) {
  const ov = $('#ai-overlay'); aiBusy++; ov.hidden = false; $('#ai-ov-title').textContent = title || 'IA Finantrix processando';
  let i = 0, done = false;
  const spin = (async () => { while (!done) { $('#ai-ov-step').textContent = '› ' + steps[i % steps.length]; $('#ai-ov-bar').style.width = `${Math.min(92, (i + 1) * 22)}%`; i++; await sleep(420); } })();
  try { return await promise; } finally { done = true; $('#ai-ov-bar').style.width = '100%'; await sleep(180); if (--aiBusy === 0) { ov.hidden = true; $('#ai-ov-bar').style.width = '0'; } spin; }
}

/* ------------------------------------------------------------------ rotas */
const ROUTES = {
  painel: { title: 'Painel', steps: ['Sincronizando agenda', 'Analisando vencimentos', 'Gerando briefing do dia'], render: renderPainel },
  agenda: { title: 'Agenda', steps: ['Carregando calendário', 'Mapeando recorrências', 'Organizando sua semana'], render: renderAgenda },
  financas: { title: 'Finanças', steps: ['Abrindo cofre local', 'Calculando fluxo do mês', 'Projetando próximos meses'], render: renderFinancas },
  secretaria: { title: 'Secretária IA', steps: ['Ativando reconhecimento de voz', 'Carregando modelo de linguagem', 'Secretária pronta'], render: renderSecretaria },
  config: { title: 'Configurações', steps: ['Carregando preferências', 'Verificando permissões'], render: renderConfig },
};
async function route(first = false) {
  const r = (location.hash.replace('#/', '') || 'painel').split('?')[0];
  const R = ROUTES[r] || ROUTES.painel;
  const changed = S.route !== r || first;
  S.route = ROUTES[r] ? r : 'painel';
  $$('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === S.route));
  $('#view-title').textContent = R.title;
  if (changed && !first) await aiWork(R.steps, 750);
  render();
  if (changed) { window.scrollTo(0, 0); }
}
function render() { const R = ROUTES[S.route]; const v = $('#view'); v.innerHTML = ''; R.render(v); fillIcons(v); updateBadge(); }

/* ------------------------------------------------------------------ helpers de UI */
function toast(head, body = '', level = 'info', action) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<span class="t-ic">${icon(level === 'ok' ? 'check' : level === 'bad' ? 'alert' : 'bell', 20)}</span><div><b>${esc(head)}</b>${body ? `<p>${esc(body)}</p>` : ''}${action ? `<button class="btn sm t-act" style="margin-top:8px;color:var(--y);border:1px solid var(--line-y)">${esc(action.label)}</button>` : ''}</div><button aria-label="Fechar">${icon('x', 16)}</button>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  el.querySelector('.t-act')?.addEventListener('click', () => { action.fn(); close(); });
  el.querySelector(':scope > button').addEventListener('click', close);
  $('#toasts').prepend(el);
  setTimeout(close, level === 'bad' ? 12000 : 6000);
}

function modal(html, { wide = false, onMount } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  $('#modal-root').appendChild(wrap);
  fillIcons(wrap);
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  onMount && onMount(wrap.firstElementChild, close);
  return close;
}

const catIcon = (k, size = 20) => { const c = cat(k); return `<span class="cat-ic" style="--c:${c.color}">${icon(c.icon, size)}</span>`; };
const statusChip = occ => {
  const st = status(occ);
  const label = occ.item.kind === 'bill' ? STATUS_LABEL[st] : TASK_STATUS_LABEL[st];
  return `<span class="chip ${st}">${label}</span>`;
};
const findOcc = (itemId, date) => {
  const it = S.items.find(i => i.id === itemId); if (!it) return null;
  const d = parseISO(date);
  return occurrences(it, d, d)[0] || null;
};
const occRange = (from, to, pred = () => true) => allOccurrences(S.items, from, to).filter(pred);

function occRow(o, { showDate = true, compact = false } = {}) {
  const it = o.item, done = isDone(o), st = status(o);
  const meta = [];
  if (showDate) meta.push(`<span>${icon('calendar', 13)} ${relDay(o.date) === 'hoje' || relDay(o.date) === 'amanhã' || relDay(o.date) === 'ontem' ? relDay(o.date) : fmtDate(o.date)}</span>`);
  if (it.time) meta.push(`<span>${icon('clock', 13)} ${it.time}</span>`);
  if (it.recurrence) meta.push(`<span>${icon('repeat', 13)} ${describeRecurrence(it.recurrence)}</span>`);
  if (o.edited) meta.push(`<span class="edited-tag">${icon('edit', 12)} só este dia</span>`);
  if (it.kind === 'bill' && !compact) meta.push(statusChip(o));
  if ((it.files || []).some(f => !f.key || f.key === o.key)) meta.push(`<span>${icon('clip', 13)} anexo</span>`);
  const right = it.kind === 'bill'
    ? `${amountOf(o) ? `<span class="r-amount">${brl(amountOf(o))}</span>` : ''}${done ? '' : `<button class="btn sm primary" data-pay="${it.id}|${o.date}">${icon('check', 15)} Pagar</button>`}`
    : `${compact ? '' : statusChip(o)}<button class="check ${done ? 'on' : ''}" data-toggle="${it.id}|${o.date}" aria-label="Concluir">${icon('check', 15)}</button>`;
  const del = `<button class="del-btn" data-del="${it.id}|${o.date}" title="Excluir" aria-label="Excluir">${icon('trash', 15)}</button>`;
  return `<div class="row ${done ? 'done' : ''}" data-open="${it.id}|${o.date}">
    ${catIcon(it.category)}
    <div style="min-width:0"><div class="r-title">${esc(it.title)}</div><div class="r-meta">${meta.join('')}</div></div>
    <div class="r-right">${right}${del}</div></div>`;
}
function bindRows(root) {
  if (root.dataset.rowsBound) return; root.dataset.rowsBound = '1';
  root.addEventListener('click', async e => {
    const delb = e.target.closest('[data-del]');
    if (delb) { e.stopPropagation(); const [id, d] = delb.dataset.del.split('|'); const o = findOcc(id, d); if (o) deleteFlow(o); return; }
    const pay = e.target.closest('[data-pay]'), tog = e.target.closest('[data-toggle]'), open = e.target.closest('[data-open]');
    if (pay) { e.stopPropagation(); const [id, d] = pay.dataset.pay.split('|'); const o = findOcc(id, d); if (o) payFlow(o); return; }
    if (tog) { e.stopPropagation(); const [id, d] = tog.dataset.toggle.split('|'); const o = findOcc(id, d); if (o) await toggleDone(o); return; }
    if (open) { const [id, d] = open.dataset.open.split('|'); const o = findOcc(id, d); if (o) detailModal(o); }
  });
}
async function toggleDone(o, silent) {
  const it = baseOf(o.item);
  it.completions = it.completions || {};
  if (it.completions[o.key]) delete it.completions[o.key]; else it.completions[o.key] = Date.now();
  await saveItem(it);
  if (!silent && it.completions[o.key]) { toast('Concluído', it.title, 'ok'); chime(); }
  render(); tick();
}

/* ------------------------------------------------------------------ PAINEL */
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; }

function briefing() {
  const t = today();
  const todayOcc = occRange(t, t, o => o.item.kind !== 'bill' && !isDone(o));
  const tomorrow = occRange(addDays(t, 1), addDays(t, 1), o => o.item.kind !== 'bill');
  const bills = occRange(addDays(t, -60), addDays(t, S.settings.billDaysBefore || 3), o => o.item.kind === 'bill' && !isDone(o));
  const overdue = bills.filter(o => status(o) === 'overdue');
  const dueSoon = bills.filter(o => status(o) !== 'overdue');
  const parts = [];
  if (todayOcc.length) {
    const first = todayOcc.find(o => o.item.time);
    parts.push(`Hoje você tem ${todayOcc.length} ${todayOcc.length === 1 ? 'item na agenda' : 'itens na agenda'}${first ? `, o próximo é “${first.item.title}” às ${first.item.time}` : ''}.`);
  } else parts.push('Sua agenda de hoje está livre.');
  if (dueSoon.length) parts.push(`${dueSoon.length === 1 ? 'Uma conta vence' : `${dueSoon.length} contas vencem`} nos próximos dias, somando ${brl(dueSoon.reduce((s, o) => s + amountOf(o), 0))}.`);
  if (overdue.length) parts.push(`Atenção: ${overdue.length === 1 ? `“${overdue[0].item.title}” está vencida` : `${overdue.length} contas estão vencidas`}.`);
  if (tomorrow.length) parts.push(`Amanhã: ${tomorrow.slice(0, 2).map(o => `${o.item.title}${o.item.time ? ` às ${o.item.time}` : ''}`).join(' e ')}${tomorrow.length > 2 ? ` e mais ${tomorrow.length - 2}` : ''}.`);
  if (!S.items.length) return 'Eu sou sua secretária virtual. Toque no microfone e me diga o que anotar — compromissos, tarefas ou contas a pagar. Eu cuido dos lembretes.';
  return parts.join(' ');
}

function renderPainel(v) {
  const t = today(), mStart = new Date(t.getFullYear(), t.getMonth(), 1), mEnd = new Date(t.getFullYear(), t.getMonth(), daysIn(t));
  const monthBills = occRange(mStart, mEnd, o => o.item.kind === 'bill');
  const paid = monthBills.filter(isDone), pending = monthBills.filter(o => !isDone(o));
  const overdueAll = occRange(addDays(t, -60), addDays(t, -1), o => o.item.kind === 'bill' && !isDone(o));
  const todayList = occRange(t, t);
  const next7 = occRange(addDays(t, 1), addDays(t, 7), o => o.item.kind !== 'bill');
  const upcomingBills = [...overdueAll, ...occRange(t, addDays(t, 20), o => o.item.kind === 'bill' && !isDone(o))].slice(0, 6);
  const alerts = computeAlerts(S.items, S.settings);
  const sum = a => a.reduce((s, o) => s + amountOf(o), 0);
  const name = S.settings.name ? `, <em>${esc(S.settings.name.split(' ')[0])}</em>` : '';

  v.innerHTML = `
    ${notifPermission() === 'default' ? `<div class="perm-banner">${icon('bell', 22)}<p><b>Ative as notificações</b> para receber os alertas de contas e compromissos mesmo com o Finantrix em segundo plano.</p><button class="btn primary sm" id="perm-btn">Ativar alertas</button></div>` : ''}
    <div class="card glow hero">
      <div>
        <span class="hero-tag mono"><i></i> Briefing da secretária · ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <h2 style="margin-top:10px">${greeting()}${name}.</h2>
        <p class="brief" id="brief"></p>
      </div>
      <div class="hero-actions">
        <button class="btn primary" id="h-voice">${icon('mic', 18)} Falar com a secretária</button>
        <button class="btn" id="h-add">${icon('plus', 18)} Nova anotação</button>
      </div>
    </div>

    <div class="grid g-4 mt">
      <div class="card kpi"><small><span class="dot" style="color:var(--y)"></span> Agenda de hoje</small><strong>${todayList.filter(o => o.item.kind !== 'bill').length}</strong><span class="sub">${todayList.filter(o => o.item.kind !== 'bill' && isDone(o)).length} concluídos</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--info)"></span> A pagar no mês</small><strong>${brl(sum(pending))}</strong><span class="sub">${pending.length} ${pending.length === 1 ? 'conta pendente' : 'contas pendentes'}</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--bad)"></span> Vencidas</small><strong style="${overdueAll.length ? 'color:var(--bad)' : ''}">${overdueAll.length}</strong><span class="sub">${overdueAll.length ? brl(sum(overdueAll)) + ' em atraso' : 'Tudo em dia ✓'}</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--ok)"></span> Pago no mês</small><strong style="color:var(--ok)">${brl(sum(paid))}</strong><span class="sub">${monthBills.length ? Math.round(paid.length / monthBills.length * 100) : 0}% das contas</span></div>
    </div>

    <div class="grid g-main mt">
      <div class="grid" style="align-content:start">
        <div class="card"><h3>${icon('clock', 16)} Hoje <span class="link" data-go="agenda">Ver agenda →</span></h3>
          ${todayList.length ? `<div class="timeline">${todayList.map(o => `<div class="tl-item ${o.item.time && o.item.time < new Date().toTimeString().slice(0, 5) ? 'past' : ''}">${o.item.time ? `<div class="tl-time">${o.item.time}</div>` : ''}${occRow(o, { showDate: false })}</div>`).join('')}</div>`
            : `<div class="empty"><b>Nada para hoje</b>Aproveite o dia — ou peça pra secretária anotar algo.</div>`}
        </div>
        <div class="card"><h3>${icon('calendar', 16)} Próximos 7 dias</h3>
          ${next7.length ? `<div class="list">${next7.slice(0, 8).map(o => occRow(o)).join('')}</div>` : `<div class="empty">Nenhum compromisso na próxima semana.</div>`}
        </div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>${icon('wallet', 16)} Contas a pagar <span class="link" data-go="financas">Finanças →</span></h3>
          ${upcomingBills.length ? `<div class="list">${upcomingBills.map(o => occRow(o, { compact: false })).join('')}</div>` : `<div class="empty"><b>Nenhuma conta pendente</b>Cadastre suas contas fixas e eu aviso no vencimento.</div>`}
        </div>
        <div class="card"><h3>${icon('bell', 16)} Alertas ativos</h3>
          ${alerts.length ? alerts.slice(0, 5).map(alertHTML).join('') : `<div class="empty">Sem alertas no momento.</div>`}
        </div>
      </div>
    </div>`;
  bindRows(v);
  $$('[data-go]', v).forEach(b => b.onclick = () => location.hash = '#/' + b.dataset.go);
  $('#h-voice', v).onclick = () => startVoice();
  $('#h-add', v).onclick = () => itemForm();
  $('#perm-btn', v)?.addEventListener('click', askPermission);
  bindAlerts(v);
  typewrite($('#brief', v), briefing());
}
let typeTimer = null;
function typewrite(el, text) {
  clearInterval(typeTimer); let i = 0; el.innerHTML = '<span></span><i class="caret"></i>'; const sp = el.firstChild;
  typeTimer = setInterval(() => { sp.textContent = text.slice(0, ++i); if (i >= text.length) { clearInterval(typeTimer); setTimeout(() => el.querySelector('.caret')?.remove(), 1600); } }, 14);
}

/* ------------------------------------------------------------------ AGENDA */
function renderAgenda(v) {
  const A = S.agenda;
  const filt = o => A.filter === 'all' ? true : A.filter === 'task' ? o.item.kind === 'task' : A.filter === 'event' ? o.item.kind === 'event' : o.item.kind === 'bill';
  const c = A.cursor;
  let title, body;
  if (A.mode === 'mes') {
    title = `${MONTHS[c.getMonth()]} ${c.getFullYear()}`;
    const first = new Date(c.getFullYear(), c.getMonth(), 1);
    const start = addDays(first, -first.getDay());
    const end = addDays(start, 41);
    const occ = occRange(start, end, filt);
    const byDay = {}; occ.forEach(o => (byDay[o.date] = byDay[o.date] || []).push(o));
    let cells = WD_SHORT.map(w => `<div class="wd">${w}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i), k = iso(d), list = byDay[k] || [];
      cells += `<div class="day ${d.getMonth() !== c.getMonth() ? 'out' : ''} ${k === iso(today()) ? 'today' : ''} ${k === A.sel ? 'sel' : ''}" data-day="${k}">
        <div class="num">${d.getDate()}</div>
        <div class="evs">${list.slice(0, 3).map(o => `<div class="ev ${isDone(o) ? 'done' : ''}" style="--c:${cat(o.item.category).color}" title="${o.item.time ? o.item.time + ' · ' : ''}${esc(o.item.title)}">${esc(o.item.title)}</div><i class="dotc" style="--c:${cat(o.item.category).color}"></i>`).join('')}${list.length > 3 ? `<div class="more">+${list.length - 3}</div>` : ''}</div></div>`;
    }
    body = `<div class="grid g-main"><div class="card"><div class="cal">${cells}</div></div><div class="card" id="daypanel"></div></div>`;
  } else if (A.mode === 'semana') {
    const start = addDays(c, -c.getDay()), end = addDays(start, 6);
    title = `${fmtDate(start)} – ${fmtDate(end)}`;
    const occ = occRange(start, end, filt);
    body = `<div class="week">${[...Array(7)].map((_, i) => { const d = addDays(start, i), k = iso(d); const list = occ.filter(o => o.date === k);
      return `<div class="col ${k === iso(today()) ? 'today' : ''}"><header><span>${WD_SHORT[i]}</span><b>${d.getDate()}</b></header>
        ${list.map(o => `<div class="wk-item ${isDone(o) ? 'done' : ''}" style="--c:${cat(o.item.category).color}" data-open="${o.item.id}|${o.date}"><small>${o.item.time || 'dia todo'}${o.item.kind === 'bill' && amountOf(o) ? ' · ' + brl(amountOf(o)) : ''}</small>${esc(o.item.title)}</div>`).join('')}
        <button class="btn sm ghost" style="width:100%;margin-top:4px" data-addday="${k}">${icon('plus', 14)}</button></div>`; }).join('')}</div>`;
  } else {
    title = 'Próximos 45 dias';
    const occ = occRange(addDays(today(), -7), addDays(today(), 45), o => filt(o) && (!isDone(o) || o.date >= iso(today())));
    const groups = {}; occ.forEach(o => (groups[o.date] = groups[o.date] || []).push(o));
    body = Object.keys(groups).length ? Object.entries(groups).map(([d, list]) => `<div class="card mt"><h3>${relDay(d) === 'hoje' ? 'Hoje' : relDay(d) === 'amanhã' ? 'Amanhã' : ''} ${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}</h3><div class="list">${list.map(o => occRow(o, { showDate: false })).join('')}</div></div>`).join('')
      : `<div class="empty">Nada agendado. Fale com a secretária ou toque em “Nova”.</div>`;
  }
  v.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="a-mode">${[['mes', 'Mês'], ['semana', 'Semana'], ['lista', 'Lista']].map(([k, l]) => `<button class="${A.mode === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div>
      ${A.mode !== 'lista' ? `<div class="month-nav"><button class="icon-btn" id="a-prev">${icon('chevL')}</button><strong>${title}</strong><button class="icon-btn" id="a-next">${icon('chevR')}</button><button class="btn sm ghost" id="a-today">Hoje</button></div>` : `<strong>${title}</strong>`}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div class="seg" id="a-filter">${[['all', 'Tudo'], ['event', 'Compromissos'], ['task', 'Tarefas'], ['bill', 'Contas']].map(([k, l]) => `<button class="${A.filter === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div>
        <button class="btn primary" id="a-add">${icon('plus', 18)} Nova</button>
      </div>
    </div>${body}`;
  $$('#a-mode button', v).forEach(b => b.onclick = () => { A.mode = b.dataset.v; render(); });
  $$('#a-filter button', v).forEach(b => b.onclick = () => { A.filter = b.dataset.v; render(); });
  $('#a-add', v).onclick = () => itemForm(null, { date: A.sel });
  $('#a-prev', v)?.addEventListener('click', () => { A.cursor = A.mode === 'mes' ? addMonths(new Date(c.getFullYear(), c.getMonth(), 1), -1) : addDays(c, -7); render(); });
  $('#a-next', v)?.addEventListener('click', () => { A.cursor = A.mode === 'mes' ? addMonths(new Date(c.getFullYear(), c.getMonth(), 1), 1) : addDays(c, 7); render(); });
  $('#a-today', v)?.addEventListener('click', () => { A.cursor = today(); A.sel = iso(today()); render(); });
  $$('[data-day]', v).forEach(d => d.onclick = () => { A.sel = d.dataset.day; $$('.day.sel', v).forEach(x => x.classList.remove('sel')); d.classList.add('sel'); dayPanel(); });
  $$('[data-addday]', v).forEach(b => b.onclick = () => itemForm(null, { date: b.dataset.addday }));
  bindRows(v);
  const dayPanel = () => {
    const p = $('#daypanel', v); if (!p) return;
    const d = parseISO(A.sel), list = occRange(d, d, filt);
    p.innerHTML = `<h3>${fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' })}<span class="link" id="dp-add">+ Adicionar</span></h3>
      ${list.length ? `<div class="list">${list.map(o => occRow(o, { showDate: false })).join('')}</div>` : `<div class="empty"><b>Dia livre</b>Nada anotado para ${relDay(d)}.</div>`}`;
    $('#dp-add', p).onclick = () => itemForm(null, { date: A.sel });
  };
  dayPanel();
}

/* ------------------------------------------------------------------ FINANÇAS */
function renderFinancas(v) {
  const F = S.fin, c = F.cursor;
  const mStart = new Date(c.getFullYear(), c.getMonth(), 1), mEnd = new Date(c.getFullYear(), c.getMonth(), daysIn(c));
  const bills = occRange(mStart, mEnd, o => o.item.kind === 'bill');
  const sum = a => a.reduce((s, o) => s + amountOf(o), 0);
  const paid = bills.filter(isDone), overdue = bills.filter(o => status(o) === 'overdue'), open = bills.filter(o => !isDone(o));
  const total = sum(bills), pct = total ? sum(paid) / total : 0;
  const filtered = bills.filter(o => F.filter === 'all' ? true : F.filter === 'pending' ? !isDone(o) : F.filter === 'paid' ? isDone(o) : status(o) === 'overdue');

  // série: 5 meses anteriores + atual + 2 projetados
  const series = [];
  for (let i = -5; i <= 2; i++) {
    const m = addMonths(mStart, i), s = new Date(m.getFullYear(), m.getMonth(), 1), e = new Date(m.getFullYear(), m.getMonth(), daysIn(m));
    const occ = occRange(s, e, o => o.item.kind === 'bill');
    series.push({ label: MONTHS[m.getMonth()].slice(0, 3), total: sum(occ), paid: sum(occ.filter(isDone)), cur: i === 0, future: monthKey(m) > monthKey(today()) });
  }
  const max = Math.max(1, ...series.map(s => s.total));
  const byCat = {}; bills.forEach(o => byCat[o.item.category] = (byCat[o.item.category] || 0) + amountOf(o));
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...cats.map(c => c[1]));
  const R = 62, C = 2 * Math.PI * R;
  const templates = S.items.filter(i => i.kind === 'bill');

  v.innerHTML = `
    <div class="toolbar">
      <div class="month-nav"><button class="icon-btn" id="f-prev">${icon('chevL')}</button><strong>${MONTHS[c.getMonth()]} ${c.getFullYear()}</strong><button class="icon-btn" id="f-next">${icon('chevR')}</button><button class="btn sm ghost" id="f-today">Mês atual</button></div>
      <button class="btn primary" id="f-add">${icon('plus', 18)} Nova conta</button>
    </div>
    <div class="grid g-4">
      <div class="card kpi"><small><span class="dot" style="color:var(--y)"></span> Total do mês</small><strong>${brl(total)}</strong><span class="sub">${bills.length} contas</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--ok)"></span> Pago</small><strong style="color:var(--ok)">${brl(sum(paid))}</strong><span class="sub">${paid.length} confirmadas</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--info)"></span> Pendente</small><strong>${brl(sum(open))}</strong><span class="sub">${open.length} em aberto</span></div>
      <div class="card kpi"><small><span class="dot" style="color:var(--bad)"></span> Vencido</small><strong style="${overdue.length ? 'color:var(--bad)' : ''}">${brl(sum(overdue))}</strong><span class="sub">${overdue.length ? overdue.length + ' em atraso' : 'Nada vencido ✓'}</span></div>
    </div>

    <div class="grid g-3 mt">
      <div class="card" style="display:flex;gap:22px;align-items:center">
        <div class="ring"><svg width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="${R}" stroke="rgba(255,255,255,.07)" stroke-width="12" fill="none"/>
          <circle cx="75" cy="75" r="${R}" stroke="url(#gr)" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}" style="transition:stroke-dashoffset 1s"/>
          <defs><linearGradient id="gr" x1="0" x2="1"><stop offset="0" stop-color="#3ef0a0"/><stop offset="1" stop-color="#FFEE32"/></linearGradient></defs></svg>
          <div class="center"><strong>${Math.round(pct * 100)}%</strong><small>quitado</small></div></div>
        <div class="kpi"><small>Saúde financeira do mês</small><span style="font-size:14px;color:#c9ced7">${!bills.length ? 'Cadastre suas contas para acompanhar.' : overdue.length ? `Você tem ${overdue.length} ${overdue.length === 1 ? 'conta vencida' : 'contas vencidas'}. Priorize ${esc(overdue[0].item.title)}.` : open.length ? `Faltam ${brl(sum(open))}. Próximo vencimento: ${esc(open[0].item.title)} ${relDay(open[0].date)}.` : 'Tudo pago neste mês. Excelente!'}</span></div>
      </div>
      <div class="card"><h3>${icon('trend', 16)} Fluxo · 6 meses + projeção</h3>
        <div class="bars">${series.map(s => `<div class="bar ${s.cur ? 'cur' : ''}"><div class="col ${s.future ? 'future' : s.paid >= s.total && s.total ? 'paid' : ''}" style="height:${s.total / max * 100}%"><span>${s.total ? (s.total >= 1000 ? (s.total / 1000).toFixed(1) + 'k' : Math.round(s.total)) : ''}</span></div><small>${s.label}</small></div>`).join('')}</div>
      </div>
      <div class="card"><h3>${icon('tag', 16)} Por categoria</h3>
        ${cats.length ? `<div class="catbars">${cats.map(([k, val]) => `<div class="catbar" style="--c:${cat(k).color}"><span>${cat(k).label}</span><div class="track"><i style="width:${val / catMax * 100}%"></i></div><b>${brl(val)}</b></div>`).join('')}</div>` : `<div class="empty">Sem dados neste mês.</div>`}
      </div>
    </div>

    <div class="grid g-main mt">
      <div class="card"><h3>Contas de ${MONTHS[c.getMonth()]}
        <div class="seg" id="f-filter">${[['all', 'Todas'], ['pending', 'Pendentes'], ['paid', 'Pagas'], ['overdue', 'Vencidas']].map(([k, l]) => `<button class="${F.filter === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div></h3>
        ${filtered.length ? `<div class="list">${filtered.map(o => occRow(o)).join('')}</div>` : `<div class="empty">Nenhuma conta neste filtro.</div>`}
      </div>
      <div class="card"><h3>${icon('repeat', 16)} Contas cadastradas</h3>
        ${templates.length ? `<div class="list">${templates.map(it => `<div class="row" data-edit="${it.id}">${catIcon(it.category)}<div style="min-width:0"><div class="r-title">${esc(it.title)}</div><div class="r-meta"><span>${describeRecurrence(it.recurrence)}${!it.recurrence && it.date ? ' · ' + fmtDate(it.date) : ''}</span></div></div><div class="r-right"><span class="r-amount">${it.amount ? brl(it.amount) : '—'}</span><button class="del-btn" data-delitem="${it.id}" title="Excluir" aria-label="Excluir">${icon('trash', 15)}</button></div></div>`).join('')}</div>` : `<div class="empty"><b>Nenhuma conta</b>Ex.: diga “energia todo dia 15, 180 reais”.</div>`}
      </div>
    </div>`;
  $('#f-prev', v).onclick = () => { F.cursor = addMonths(mStart, -1); render(); };
  $('#f-next', v).onclick = () => { F.cursor = addMonths(mStart, 1); render(); };
  $('#f-today', v).onclick = () => { F.cursor = new Date(today().getFullYear(), today().getMonth(), 1); render(); };
  $('#f-add', v).onclick = () => itemForm(null, { kind: 'bill' });
  $$('#f-filter button', v).forEach(b => b.onclick = e => { e.stopPropagation(); F.filter = b.dataset.v; render(); });
  $$('[data-edit]', v).forEach(r => r.onclick = e => { const it = S.items.find(i => i.id === r.dataset.edit); if (e.target.closest('[data-delitem]')) return deleteFlow({ item: it, date: it.date, key: 'once' }, true); itemForm(it); });
  bindRows(v);
}

/* ------------------------------------------------------------------ SECRETÁRIA */
function renderSecretaria(v) {
  const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  v.innerHTML = `
    <div class="grid g-main">
      <div class="card glow">
        <h3><span style="display:flex;align-items:center;gap:8px"><img src="assets/img/mark.svg" width="16" alt=""> Secretária virtual</span><span class="chip ${S.settings.apiKey ? 'paid' : 'pending'}">${S.settings.apiKey ? 'IA Premium · Claude' : 'IA local'}</span></h3>
        <div class="chat" id="chat"></div>
        <div class="composer">
          <input id="say" placeholder="Digite ou toque no microfone… ex.: amanhã tenho dentista às 9h" autocomplete="off">
          <button class="icon-btn" id="send" aria-label="Enviar">${icon('send', 18)}</button>
          <button class="mic-btn" id="mic" aria-label="Falar">${icon('mic', 24)}</button>
        </div>
        <div class="suggest">${['Amanhã tenho médico às 14h', 'Conta de energia todo dia 15, 180 reais', 'O que eu tenho amanhã?', 'Quanto falta pagar este mês?', 'Já paguei a energia', 'Toda segunda academia às 7h'].map(s => `<button>${s}</button>`).join('')}</div>
        ${hasSR ? '' : `<p style="color:var(--warn);font-size:13px;margin:12px 0 0">Este navegador não tem reconhecimento de voz. Use Google Chrome, Edge ou Safari para falar — digitar funciona em qualquer um.</p>`}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h3>O que eu entendo</h3>
          <div class="list" style="font-size:13.5px;color:#c9ced7;gap:12px">
            <div><b style="color:var(--y)">Compromissos</b><br>“Dentista dia 30 às 9h30”, “Reunião sexta às 3 da tarde”</div>
            <div><b style="color:var(--y)">Contas fixas</b><br>“Aluguel de 1.500 reais todo dia 5”, “Internet dia 10, R$ 99,90”</div>
            <div><b style="color:var(--y)">Tarefas e recorrências</b><br>“Comprar remédio hoje”, “Toda segunda academia às 7h”</div>
            <div><b style="color:var(--y)">Confirmar pagamento</b><br>“Já paguei a luz” — eu peço o seu OK antes de marcar.</div>
            <div><b style="color:var(--y)">Perguntas</b><br>“O que tenho amanhã?”, “Quanto falta pagar este mês?”, “Tenho conta vencida?”</div>
            <div><b style="color:var(--y)">Várias de uma vez</b><br>“Amanhã tenho médico às 10h. Também preciso pagar a água dia 20.”</div>
          </div>
        </div>
        <div class="card"><h3>Preferências rápidas</h3>
          <div class="set-row"><div><b>Responder em voz alta</b><p>A secretária fala a confirmação.</p></div><label class="toggle"><input type="checkbox" id="q-voice" ${S.settings.voiceReply ? 'checked' : ''}><span></span></label></div>
          <div class="set-row"><div><b>Limpar conversa</b><p>Apaga só o histórico do chat.</p></div><button class="btn sm" id="q-clear">Limpar</button></div>
        </div>
      </div>
    </div>`;
  const chat = $('#chat', v);
  if (!S.chat.length) S.chat.push({ who: 'ai', html: `${greeting()}! Sou a secretária do Finantrix. Me diga o que precisa anotar — por voz ou texto — e eu organizo sua agenda, suas contas e te aviso na hora certa.` });
  chat.innerHTML = S.chat.map(msgHTML).join('');
  chat.scrollTop = chat.scrollHeight;
  bindChat(chat);
  const send = () => { const t = $('#say', v).value.trim(); if (t) { $('#say', v).value = ''; handleUtterance(t); } };
  $('#send', v).onclick = send;
  $('#say', v).addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  $('#mic', v).onclick = () => startVoice();
  $$('.suggest button', v).forEach(b => b.onclick = () => handleUtterance(b.textContent));
  $('#q-voice', v).onchange = e => { S.settings.voiceReply = e.target.checked; saveSettings(); };
  $('#q-clear', v).onclick = async () => { S.chat = []; await saveChat(); render(); };
}
function msgHTML(m) {
  if (m.who === 'me') return `<div class="msg me">${esc(m.text)}</div>`;
  return `<div class="msg ai"><div class="who"><img src="assets/img/mark.svg" alt=""> Secretária${m.ai ? ' · Claude' : ''}</div>${m.html}</div>`;
}
function bindChat(chat) {
  bindRows(chat);
  chat.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    e.stopPropagation();
    const [act, id, date] = b.dataset.act.split('|');
    const it = S.items.find(i => i.id === id);
    if (act === 'edit' && it) itemForm(it);
    if (act === 'undo' && it) { await deleteItem(id); b.closest('.draft').style.opacity = .4; b.closest('.draft-actions').innerHTML = '<span class="chip neutral">Removido</span>'; tick(); }
    if (act === 'pay' && it) { const o = findOcc(id, date); if (o) payFlow(o); }
  });
}
async function pushMsg(m) {
  S.chat.push(m); await saveChat();
  const chat = $('#chat'); if (!chat) return;
  chat.insertAdjacentHTML('beforeend', msgHTML(m)); fillIcons(chat); chat.scrollTop = chat.scrollHeight;
}

function draftCard(it, { saved = true } = {}) {
  const c = cat(it.category);
  const when = it.recurrence ? describeRecurrence(it.recurrence) + (it.time ? ` · ${it.time}` : '') : `${it.date ? fmtDate(it.date, { weekday: 'short', day: '2-digit', month: 'short' }) : 'sem data'}${it.time ? ` · ${it.time}` : ''}`;
  return `<div class="draft">${catIcon(it.category)}<div>
    <b>${esc(it.title)}</b> <span class="chip neutral">${it.kind === 'bill' ? 'Conta' : it.kind === 'event' ? 'Compromisso' : 'Tarefa'}</span>
    <div class="r-meta" style="margin-top:4px"><span>${icon('calendar', 13)} ${when}</span>${it.amount ? `<span>${icon('wallet', 13)} ${brl(it.amount)}</span>` : ''}<span>${icon(c.icon, 13)} ${c.label}</span></div>
    <div class="draft-actions">${saved ? `<span class="chip paid">${icon('check', 12)} Anotado</span><button class="btn sm" data-act="edit|${it.id}">${icon('edit', 14)} Editar</button><button class="btn sm ghost" data-act="undo|${it.id}">Desfazer</button>${it.kind === 'bill' ? `<button class="btn sm ghost" data-act="edit|${it.id}">${icon('clip', 14)} Anexar boleto</button>` : ''}` : ''}</div>
  </div></div>`;
}

async function handleUtterance(text) {
  if (S.route !== 'secretaria') { location.hash = '#/secretaria'; await sleep(900); }
  await pushMsg({ who: 'me', text });
  const chat = $('#chat');
  chat && chat.insertAdjacentHTML('beforeend', `<div class="msg ai" id="typing"><div class="typing"><i></i><i></i><i></i></div></div>`);
  chat && (chat.scrollTop = chat.scrollHeight);

  const steps = S.settings.apiKey
    ? ['Transcrevendo intenção', 'Consultando Claude', 'Extraindo datas e valores', 'Validando com sua agenda']
    : ['Analisando linguagem natural', 'Detectando datas e horários', 'Identificando valores', 'Classificando categoria'];
  let res;
  try {
    res = await aiWhile((async () => {
      const minTime = sleep(1100);
      let r;
      if (S.settings.apiKey) {
        try { r = await aiInterpret(text, S.items, S.settings.apiKey); }
        catch (e) { console.warn('IA Claude indisponível, usando IA local:', e); r = interpret(text, S.items); r.aiError = e.message; }
      } else r = interpret(text, S.items);
      await minTime; return r;
    })(), steps, 'Secretária pensando');
  } finally { $('#typing')?.remove(); }

  if (res.intent === 'create') {
    const saved = [], needsDate = [];
    for (const d of res.items) {
      if (!d.title) continue;
      if (d.kind === 'bill' && !d.date && !d.recurrence) { needsDate.push(d); continue; }
      const it = draftToItem(d);
      await saveItem(it); saved.push(it);
    }
    let reply = res.reply && saved.length ? res.reply : saved.length ? confirmText(saved) : '';
    if (needsDate.length) reply += `${reply ? ' ' : ''}Para “${needsDate[0].title}” preciso do dia do vencimento — abri o formulário pra você completar.`;
    if (!saved.length && !needsDate.length) reply = 'Não consegui entender o que anotar. Pode repetir com o dia e o horário? Ex.: “amanhã às 10h reunião”.';
    await pushMsg({ who: 'ai', ai: res.ai, html: `${esc(reply)}${saved.length ? `<div class="drafts">${saved.map(it => draftCard(it)).join('')}</div>` : ''}` });
    speak(reply, S.settings.voiceReply);
    if (needsDate.length) itemForm(null, draftToItem(needsDate[0]), true);
    if (saved.length) { chime(); tick(); }
  } else if (res.intent === 'pay' || res.intent === 'complete') {
    const it = res.target || findItem(text.toLowerCase(), S.items, res.intent === 'pay' ? 'bill' : null);
    if (!it) { const r = 'Não encontrei essa conta na sua lista. Quer que eu cadastre?'; await pushMsg({ who: 'ai', html: esc(r) }); speak(r, S.settings.voiceReply); return; }
    const o = nearestOpenOcc(it);
    if (!o) { const r = `“${it.title}” já está em dia, nada pendente.`; await pushMsg({ who: 'ai', html: esc(r) }); speak(r, S.settings.voiceReply); return; }
    if (res.intent === 'pay') {
      if (res.amount) { it.amounts = it.amounts || {}; it.amounts[o.key] = res.amount; }
      const r = `Encontrei ${it.title} com vencimento ${relDay(o.date)} (${fmtDate(o.date)})${amountOf(o) ? `, valor ${brl(res.amount || amountOf(o))}` : ''}. Confirma que já foi pago?`;
      await pushMsg({ who: 'ai', html: `${esc(r)}<div class="drafts"><div class="draft">${catIcon(it.category)}<div><b>${esc(it.title)}</b> ${statusChip(o)}<div class="draft-actions"><button class="btn sm ok" data-act="pay|${it.id}|${o.date}">${icon('check', 14)} Sim, confirmar pagamento</button></div></div></div></div>` });
      speak(r, S.settings.voiceReply);
      payFlow(o, res.amount);
    } else {
      await toggleDone(o, true);
      const r = `Feito! Marquei “${it.title}” como concluído.`;
      await pushMsg({ who: 'ai', html: esc(r) }); speak(r, S.settings.voiceReply);
    }
  } else if (res.intent === 'query') {
    const { text: r, list } = answerQuery(res.query);
    await pushMsg({ who: 'ai', html: `${esc(r)}${list.length ? `<div class="list" style="margin-top:10px">${list.slice(0, 8).map(o => occRow(o)).join('')}</div>` : ''}` });
    speak(r, S.settings.voiceReply);
  }
  if (res.aiError) toast('IA Premium indisponível', 'Usei a IA local desta vez. Verifique sua chave em Configurações.', 'info');
}

function draftToItem(d) {
  const it = { id: uid(), kind: d.kind, title: d.title, category: CATEGORIES[d.category] ? d.category : (d.kind === 'bill' ? 'outros' : d.kind === 'event' ? 'pessoal' : 'tarefa'),
    date: d.date, time: d.time || null, recurrence: d.recurrence || null, amount: d.amount || null, notes: d.notes || '', files: [], payments: {}, completions: {}, createdAt: Date.now(), source: d.source };
  normalizeKind(it);
  if (it.recurrence) {
    if (!it.date) {
      const t = today();
      if (it.recurrence.type === 'weekly') { let x = t; while (x.getDay() !== it.recurrence.weekday) x = addDays(x, 1); it.date = iso(x); }
      else if (it.recurrence.type === 'monthly') { let x = new Date(t.getFullYear(), t.getMonth(), Math.min(it.recurrence.day, daysIn(t))); if (x < t) x = addMonths(new Date(t.getFullYear(), t.getMonth(), 1), 1), x.setDate(Math.min(it.recurrence.day, daysIn(x))); it.date = iso(x); }
      else it.date = iso(t);
    }
    it.startDate = it.date;
  }
  return it;
}
function confirmText(saved) {
  if (saved.length > 1) return `Pronto! Anotei ${saved.length} itens pra você e vou te lembrar de cada um.`;
  const it = saved[0];
  if (it.kind === 'bill') return `Anotado: ${it.title}${it.amount ? ` de ${brl(it.amount)}` : ''}, ${it.recurrence ? describeRecurrence(it.recurrence).toLowerCase() : `vencimento ${relDay(it.date)}`}. Vou te avisar antes de vencer.`;
  return `Anotado: ${it.title} ${it.recurrence ? describeRecurrence(it.recurrence).toLowerCase() : relDay(it.date)}${it.time ? ` às ${it.time}` : ''}. ${diffDays(parseISO(it.date), today()) >= 1 ? 'Te aviso na véspera e no dia.' : 'Te aviso na hora.'}`;
}
function nearestOpenOcc(it) {
  const occ = occurrences(it, addDays(today(), -90), addDays(today(), 60)).filter(o => !isDone(o));
  if (!occ.length) return null;
  return occ.find(o => o.date <= iso(addDays(today(), 31))) || occ[0];
}
function answerQuery(q) {
  const t = today();
  let from = t, to = t, label = 'hoje';
  if (q.scope === 'tomorrow') { from = to = addDays(t, 1); label = 'amanhã'; }
  else if (q.scope === 'week') { to = addDays(t, 7); label = 'nos próximos 7 dias'; }
  else if (q.scope === 'month') { from = new Date(t.getFullYear(), t.getMonth(), 1); to = new Date(t.getFullYear(), t.getMonth(), daysIn(t)); label = 'neste mês'; }
  else if (q.scope === 'date' && q.date) { from = to = parseISO(q.date); label = `em ${fmtDate(q.date, { day: 'numeric', month: 'long' })}`; }
  if (q.overdue) {
    const list = occRange(addDays(t, -90), addDays(t, -1), o => o.item.kind === 'bill' && !isDone(o));
    return { list, text: list.length ? `Você tem ${list.length} ${list.length === 1 ? 'conta vencida' : 'contas vencidas'}, somando ${brl(list.reduce((s, o) => s + amountOf(o), 0))}.` : 'Nenhuma conta vencida. Está tudo em dia!' };
  }
  if (q.topic === 'bills') {
    const list = occRange(q.scope === 'month' ? addDays(from, 0) : from, to, o => o.item.kind === 'bill');
    const open = list.filter(o => !isDone(o)), paidSum = list.filter(isDone).reduce((s, o) => s + amountOf(o), 0), openSum = open.reduce((s, o) => s + amountOf(o), 0);
    if (!list.length) return { list, text: `Não há contas ${label}.` };
    return { list: open.length ? open : list, text: open.length ? `${label.charAt(0).toUpperCase() + label.slice(1)} faltam ${brl(openSum)} em ${open.length} ${open.length === 1 ? 'conta' : 'contas'}${paidSum ? `, e você já pagou ${brl(paidSum)}` : ''}.` : `Todas as contas ${label} já estão pagas (${brl(paidSum)}).` };
  }
  const list = occRange(from, to, o => q.topic === 'events' ? o.item.kind !== 'bill' : true).filter(o => !isDone(o));
  if (!list.length) return { list, text: `Você não tem nada ${label}. Agenda livre!` };
  const names = list.slice(0, 3).map(o => `${o.item.title}${o.item.time ? ` às ${o.item.time}` : ''}`);
  return { list, text: `${label.charAt(0).toUpperCase() + label.slice(1)} você tem ${list.length} ${list.length === 1 ? 'item' : 'itens'}: ${names.join(', ')}${list.length > 3 ? ` e mais ${list.length - 3}` : ''}.` };
}

/* ------------------------------------------------------------------ CONFIG */
function renderConfig(v) {
  const perm = notifPermission();
  const permLabel = { granted: '<span class="chip paid">Ativadas</span>', denied: '<span class="chip overdue">Bloqueadas no navegador</span>', default: '<span class="chip pending">Não ativadas</span>', unsupported: '<span class="chip neutral">Não suportado</span>' }[perm];
  v.innerHTML = `
    <div class="grid g-2">
      <div class="card"><h3>${icon('user', 16)} Perfil</h3>
        <div class="field"><label>Como a secretária deve te chamar</label><input class="inp" id="c-name" value="${esc(S.settings.name)}" placeholder="Seu nome"></div>
      </div>
      <div class="card"><h3>${icon('bell', 16)} Notificações ${permLabel}</h3>
        <div class="set-row"><div><b>Permissão do sistema</b><p>${perm === 'denied' ? 'Libere nas configurações do navegador (ícone de cadeado na barra de endereço).' : 'Alertas nativos do macOS/Windows/celular.'}</p></div><div style="display:flex;gap:8px"><button class="btn sm primary" id="c-perm" ${perm === 'granted' || perm === 'unsupported' ? 'disabled' : ''}>Ativar</button><button class="btn sm" id="c-test">Testar</button></div></div>
        <div class="set-row"><div><b>Horário do resumo diário</b><p>A partir desse horário chegam os alertas do dia (contas e compromissos).</p></div><input type="time" class="inp" style="width:120px" id="c-hour" value="${S.settings.dailyHour}"></div>
        <div class="set-row"><div><b>Avisar contas com antecedência</b><p>Dias antes do vencimento.</p></div><select class="inp" style="width:120px" id="c-days">${[1, 2, 3, 5, 7].map(n => `<option ${S.settings.billDaysBefore == n ? 'selected' : ''} value="${n}">${n} ${n === 1 ? 'dia' : 'dias'}</option>`).join('')}</select></div>
        <div class="set-row"><div><b>Lembrete antes do compromisso</b><p>Minutos antes do horário marcado.</p></div><select class="inp" style="width:120px" id="c-min">${[10, 15, 30, 60, 120].map(n => `<option ${S.settings.minutesBefore == n ? 'selected' : ''} value="${n}">${n} min</option>`).join('')}</select></div>
        <div class="set-row"><div><b>Som dos alertas</b></div><label class="toggle"><input type="checkbox" id="c-sound" ${S.settings.sound ? 'checked' : ''}><span></span></label></div>
        <div class="set-row"><div><b>Secretária responde em voz alta</b></div><label class="toggle"><input type="checkbox" id="c-voice" ${S.settings.voiceReply ? 'checked' : ''}><span></span></label></div>
      </div>
      ${tgCardHTML()}
      <div class="card glow"><h3>${icon('spark', 16)} IA Premium (Claude) <span class="chip ${S.settings.apiKey ? 'paid' : 'neutral'}">${S.settings.apiKey ? 'Conectada' : 'Opcional'}</span></h3>
        <p style="color:#c9ced7;font-size:14px;margin-top:0">A IA local já entende frases comuns. Conectando sua chave da API da Anthropic, a secretária passa a usar o Claude para entender falas longas, informais e com várias informações juntas.</p>
        <div class="field"><label>Chave da API (fica salva só neste computador)</label><input class="inp" type="password" id="c-key" value="${esc(S.settings.apiKey)}" placeholder="sk-ant-..." autocomplete="off"></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary sm" id="c-key-save">Salvar chave</button><button class="btn sm" id="c-key-test">Testar conexão</button>${S.settings.apiKey ? '<button class="btn sm danger" id="c-key-del">Remover</button>' : ''}</div>
        <p style="color:var(--muted);font-size:12.5px;margin:12px 0 0">Crie a chave em console.anthropic.com. O texto que você fala é enviado à Anthropic apenas para interpretação; agenda, valores e boletos continuam somente no seu computador.</p>
      </div>
      <div class="card"><h3>${icon('download', 16)} Dados e backup</h3>
        <p style="color:#c9ced7;font-size:14px;margin-top:0">Tudo fica salvo <b>neste navegador, neste aparelho</b> e neste endereço (${esc(location.host)}). Outro aparelho, outro navegador ou outro link mostram um Finantrix separado. ${S.persisted ? '<span class="chip paid">Armazenamento protegido</span>' : '<span class="chip soon">Navegador pode limpar os dados</span>'}</p>
        <p style="color:var(--muted);font-size:13px">${tgReady() ? 'Backup automático no Telegram ativo ✓' : 'Dica: conecte o Telegram para ter backup automático fora do aparelho.'}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="c-export">${icon('download', 15)} Exportar backup</button><label class="btn sm">${icon('upload', 15)} Importar backup<input type="file" id="c-import" accept=".json" hidden></label><button class="btn sm" id="c-demo">${icon('spark', 15)} Carregar exemplos</button><button class="btn sm danger" id="c-wipe">${icon('trash', 15)} Apagar tudo</button></div>
      </div>
    </div>`;
  const set = (k, val) => { S.settings[k] = val; saveSettings(); };
  $('#c-name', v).onchange = e => set('name', e.target.value.trim());
  $('#c-hour', v).onchange = e => { set('dailyHour', e.target.value || '08:00'); tick(); };
  $('#c-days', v).onchange = e => { set('billDaysBefore', +e.target.value); tick(); };
  $('#c-min', v).onchange = e => set('minutesBefore', +e.target.value);
  $('#c-sound', v).onchange = e => set('sound', e.target.checked);
  $('#c-voice', v).onchange = e => set('voiceReply', e.target.checked);
  $('#c-perm', v).onclick = askPermission;
  $('#c-test', v).onclick = async () => {
    const a = { itemId: 'teste', date: iso(today()), key: 'once', kind: 'event', rule: 'test-' + Date.now(), level: 'info', head: 'Finantrix · teste de alerta', body: 'Assim chegam seus lembretes. ✨' };
    await fireAlerts([a], { sound: true, onFire: x => toast(x.head, x.body) });
    if (notifPermission() !== 'granted') toast('Notificação do sistema desativada', 'Ative a permissão para receber avisos fora do app.', 'bad');
  };
  $('#c-key-save', v).onclick = () => { set('apiKey', $('#c-key', v).value.trim()); toast('Chave salva', 'A secretária agora usa o Claude.', 'ok'); $('#ai-mode').textContent = S.settings.apiKey ? 'Online · Claude' : 'Online · local'; render(); };
  $('#c-key-del', v)?.addEventListener('click', () => { set('apiKey', ''); $('#ai-mode').textContent = 'Online · local'; render(); });
  bindTgCard(v);
  $('#c-key-test', v).onclick = async () => {
    const key = $('#c-key', v).value.trim(); if (!key) return toast('Informe a chave primeiro', '', 'bad');
    try { const r = await aiWhile(aiInterpret('amanhã tenho dentista às 9h', [], key), ['Conectando ao Claude', 'Autenticando', 'Teste de interpretação'], 'Testando IA Premium'); toast('Conexão OK', `Entendi: “${r.items[0]?.title}” ${r.items[0]?.date} ${r.items[0]?.time || ''}`, 'ok'); }
    catch (e) { toast('Falha na conexão', e.message || String(e), 'bad'); }
  };
  $('#c-export', v).onclick = async () => {
    const json = await aiWhile(db.exportAll(), ['Compactando dados', 'Empacotando anexos'], 'Gerando backup');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = `finantrix-backup-${iso(today())}.json`; a.click();
  };
  $('#c-import', v).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await db.importAll(await f.text()); await loadAll(); toast('Backup restaurado', '', 'ok'); render(); tick(); } catch (err) { toast('Não foi possível importar', err.message, 'bad'); } };
  $('#c-demo', v).onclick = async () => { await loadDemo(); toast('Exemplos carregados', 'Veja o painel, a agenda e as finanças.', 'ok'); location.hash = '#/painel'; };
  $('#c-wipe', v).onclick = () => modal(`<header><h2>Apagar tudo?</h2></header><div class="body">Isso remove todas as tarefas, contas e anexos deste computador. Não dá para desfazer.</div><footer><button class="btn ghost" data-close>Cancelar</button><button class="btn danger" id="w-ok">Apagar definitivamente</button></footer>`, { onMount: (m, close) => { $('#w-ok', m).onclick = async () => { await db.clear('items'); await db.clear('files'); await db.clear('notified'); S.items = []; close(); render(); tick(); toast('Dados apagados', '', 'ok'); }; } });
}
async function askPermission() {
  const r = await requestPermission();
  if (r === 'granted') { toast('Alertas ativados', 'Você vai receber os lembretes do Finantrix.', 'ok'); }
  else if (r === 'denied') toast('Permissão negada', 'Libere as notificações nas configurações do navegador.', 'bad');
  render(); tick();
}


/* ------------------------------------------------------------------ BACKUP NO TELEGRAM */
// Depois de qualquer alteração, uma cópia de tudo vai para a sua conversa com o robô (fixada no topo).
// Se o navegador perder os dados, a restauração busca essa cópia.
let lastChange = 0;
function markDirty() { lastChange = Date.now(); db.setSetting('dirtyAt', lastChange).catch(() => {}); }
async function tgBackupNow(silent = true) {
  if (!tgReady()) throw new Error('Conecte o Telegram primeiro');
  const json = await db.exportAll();
  const n = S.items.length;
  const stamp = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const msg = await sendDocument(S.settings.tgToken, S.settings.tgChatId, new Blob([json], { type: 'application/json' }),
    `finantrix-backup-${iso(today())}.json`, `🗄️ <b>Backup Finantrix</b> · ${n} ${n === 1 ? 'item' : 'itens'} · ${stamp}\nCópia de segurança automática — não apague.`);
  await tg(S.settings.tgToken, 'pinChatMessage', { chat_id: S.settings.tgChatId, message_id: msg.message_id, disable_notification: true }).catch(() => {});
  await db.setSetting('lastBackup', { at: Date.now(), items: n });
  await db.setSetting('dirtyAt', 0);
  if (!silent) toast('Backup salvo no Telegram', `${n} itens · fixado na conversa com @${S.settings.tgBot}.`, 'ok');
}
async function tgAutoBackup() {
  const dirty = lastChange || await db.getSetting('dirtyAt', 0);
  if (!dirty) return;
  const last = (await db.getSetting('lastBackup', null))?.at || 0;
  // espera 1 min sem mexer e no máximo um backup a cada 10 min
  if (Date.now() - dirty < 60e3 || Date.now() - last < 10 * 60e3) return;
  // nunca sobrescreve um backup cheio com um Finantrix vazio
  if (!S.items.length) return;
  lastChange = 0;
  await tgBackupNow(true);
}
async function tgFindBackup() {
  const chat = await tg(S.settings.tgToken, 'getChat', { chat_id: S.settings.tgChatId });
  const pm = chat.pinned_message;
  return pm && pm.document && /finantrix-backup/.test(pm.document.file_name || '') ? pm : null;
}
async function tgRestore() {
  const pm = await tgFindBackup();
  if (!pm) throw new Error('Nenhum backup encontrado na conversa do Telegram.');
  const json = await downloadFile(S.settings.tgToken, pm.document.file_id);
  const keep = { tgToken: S.settings.tgToken, tgBot: S.settings.tgBot, tgChatId: S.settings.tgChatId };
  await db.importAll(json);
  await loadAll();
  Object.assign(S.settings, keep); await saveSettings();
  render(); tick();
  toast('Dados restaurados', `${S.items.length} itens recuperados do backup de ${new Date(pm.date * 1000).toLocaleString('pt-BR')}.`, 'ok');
}
// Ao conectar (ou abrir) com o Finantrix vazio, oferece restaurar o backup do Telegram.
async function tgOfferRestore() {
  if (S.items.length || !tgReady()) return;
  const pm = await tgFindBackup().catch(() => null);
  if (!pm) return;
  const when = new Date(pm.date * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  modal(`<header><h2>Encontrei seu backup</h2></header>
    <div class="body"><p style="margin:0;color:#c9ced7">Este Finantrix está vazio, mas há uma cópia de segurança de <b>${when}</b> na sua conversa do Telegram. Quer restaurar tudo agora?</p></div>
    <footer><button class="btn ghost" data-close>Agora não</button><button class="btn primary" id="r-ok">${icon('download', 16)} Restaurar</button></footer>`, {
    onMount: (m, close) => { $('#r-ok', m).onclick = async () => { close(); try { await aiWhile(tgRestore(), ['Buscando backup no Telegram', 'Restaurando agenda', 'Restaurando contas e anexos'], 'Restaurando'); } catch (e) { toast('Falha ao restaurar', e.message, 'bad'); } }; }
  });
}

/* ------------------------------------------------------------------ TELEGRAM */
let tgStop = null;
const tgReady = () => !!(S.settings.tgToken && S.settings.tgChatId);
function tgRestart() {
  tgStop && tgStop(); tgStop = null;
  if (!S.settings.tgToken) return;
  tgStop = startPolling(S.settings.tgToken, onTgUpdate, { getOffset: () => db.getSetting('tgOffset', 0), setOffset: v => db.setSetting('tgOffset', v) });
}
const tgSend = (html, buttons) => tgSendRaw(S.settings.tgToken, S.settings.tgChatId, html, buttons);

const KIND_EMOJI = { event: '📍', task: '▫️', bill: '💸' };
function tgLine(o, { withDate = false } = {}) {
  const it = o.item, st = status(o);
  const em = it.kind === 'bill' ? (isDone(o) ? '✅' : st === 'overdue' ? '🔴' : st === 'today' || st === 'soon' ? '🟡' : '💸') : isDone(o) ? '✅' : KIND_EMOJI[it.kind];
  const parts = [`${em} <b>${tgEsc(it.title)}</b>`];
  if (it.time) parts.push(it.time);
  if (withDate) parts.push(relDay(o.date) === 'hoje' || relDay(o.date) === 'amanhã' ? relDay(o.date) : fmtDate(o.date));
  if (it.kind === 'bill' && amountOf(o)) parts.push(brl(amountOf(o)));
  if (it.kind === 'bill' && st === 'overdue' && !isDone(o)) parts.push(`venceu ${relDay(o.date)}`);
  return parts.join(' · ');
}
const payBtn = o => ({ text: `✅ Paguei: ${o.item.title}`.slice(0, 60), callback_data: `p|${o.item.id}|${o.date}` });
const doneBtn = o => ({ text: `✅ Feito: ${o.item.title}`.slice(0, 60), callback_data: `d|${o.item.id}|${o.date}` });

function tgDaily() {
  const t = today();
  const day = occRange(t, t, o => o.item.kind !== 'bill');
  const events = day.filter(o => o.item.kind === 'event'), tasks = day.filter(o => o.item.kind === 'task');
  const overdue = occRange(addDays(t, -60), addDays(t, -1), o => o.item.kind === 'bill' && !isDone(o));
  const due = occRange(t, addDays(t, S.settings.billDaysBefore || 3), o => o.item.kind === 'bill' && !isDone(o));
  const name = S.settings.name ? `, ${tgEsc(S.settings.name.split(' ')[0])}` : '';
  let html = `☀️ <b>${greeting()}${name}!</b>\nSeu dia · ${tgEsc(new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }))}\n`;
  if (events.length) html += `\n<b>📍 Compromissos</b>\n${events.map(o => tgLine(o)).join('\n')}\n`;
  if (tasks.length) html += `\n<b>📝 Tarefas</b>\n${tasks.map(o => tgLine(o)).join('\n')}\n`;
  if (overdue.length) html += `\n<b>🔴 Contas vencidas</b>\n${overdue.map(o => tgLine(o)).join('\n')}\n`;
  if (due.length) html += `\n<b>💸 Contas a vencer</b>\n${due.map(o => tgLine(o, { withDate: true })).join('\n')}\n`;
  if (!day.length && !overdue.length && !due.length) html += '\nAgenda livre e nenhuma conta vencendo. Aproveite! 🙌';
  const buttons = [...overdue, ...due.filter(o => o.date === iso(t))].slice(0, 6).map(o => [payBtn(o)]);
  return { html, buttons };
}

async function tgOnce(key, fn) {
  if (await db.get('notified', key)) return;
  await db.put('notified', { id: key, at: Date.now() });
  try { await fn(); } catch (e) { await db.del('notified', key); throw e; }
}
// Roda a cada 30 s junto com os alertas do app.
async function tgJobs(alerts) {
  if (!tgReady()) return;
  await tgAutoBackup().catch(e => console.warn('Backup Telegram', e));
  const now = new Date(), hm = now.getHours() * 60 + now.getMinutes(), t = today();
  const [dh, dm] = (S.settings.tgDailyHour || '07:30').split(':').map(Number);
  if (S.settings.tgDaily && hm >= dh * 60 + dm && now.getHours() < Math.max(18, dh + 1))
    await tgOnce(`tg-daily|${iso(t)}`, async () => { const d = tgDaily(); await tgSend(d.html, d.buttons); });
  if (S.settings.tgEvening && now.getHours() >= 19 && now.getHours() < 23) {
    const tm = addDays(t, 1), list = occRange(tm, tm, o => !isDone(o));
    if (list.length) await tgOnce(`tg-eve|${iso(t)}`, () => tgSend(`🌙 <b>Amanhã você tem:</b>\n${list.map(o => tgLine(o)).join('\n')}\n\nJá deixei tudo anotado. Boa noite!`));
  }
  if (S.settings.tgReminders) for (const a of alerts.filter(a => a.rule === 'soon')) {
    const o = findOcc(a.itemId, a.date); if (!o) continue;
    await tgOnce(`tg|${a.itemId}|${a.date}|soon`, () => tgSend(`⏰ <b>Daqui a pouco: ${tgEsc(o.item.title)}</b>\nÀs ${o.item.time}${o.item.notes ? `\n${tgEsc(o.item.notes)}` : ''}`, [[doneBtn(o)]]));
  }
}

const TG_HELP = `Sou a <b>secretária do Finantrix</b> ✨\n\nMe escreva (ou dite pelo teclado 🎤) e eu anoto:\n• <i>amanhã tenho médico às 14h</i>\n• <i>conta de luz todo dia 15, 180 reais</i>\n• <i>projeto Pilar sexta às 10h</i>\n• <i>já paguei a internet</i>\n• <i>o que tenho amanhã?</i>\n\nComandos:\n/hoje — resumo do dia\n/amanha — o que tem amanhã\n/semana — próximos 7 dias\n/contas — contas pendentes do mês`;

async function onTgUpdate(u) {
  const mine = id => String(id) === String(S.settings.tgChatId);
  if (u.callback_query) { const q = u.callback_query; if (mine(q.message?.chat?.id)) await tgCallback(q); return; }
  const m = u.message; if (!m) return;
  if (!S.settings.tgChatId) {
    // vinculação: o primeiro /start depois de conectar o robô vira o seu chat
    if (!/^\/start/.test(m.text || '')) return;
    S.settings.tgChatId = String(m.chat.id); await saveSettings();
    await tgSend(`✅ <b>Pronto${m.from?.first_name ? ', ' + tgEsc(m.from.first_name) : ''}!</b> O Finantrix está conectado.\nTodo dia às ${S.settings.tgDailyHour} eu te mando o resumo das suas demandas.\n\n${TG_HELP}`);
    toast('Telegram conectado', 'Você vai receber o resumo diário no Telegram.', 'ok'); chime();
    if (S.route === 'config') render();
    tgOfferRestore();
    return;
  }
  if (!mine(m.chat.id)) { await tgSendRaw(S.settings.tgToken, m.chat.id, 'Este é um assistente privado. 🔒'); return; }
  if (!m.text) { await tgSend('Por enquanto eu entendo mensagens de texto. Dica: use o 🎤 do teclado para ditar e enviar como texto.'); return; }
  await tgHandleText(m.text.trim());
}

async function tgHandleText(text) {
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const t = today();
  if (cmd === '/start' || cmd === '/ajuda' || cmd === '/help') return tgSend(TG_HELP);
  if (cmd === '/hoje') { const d = tgDaily(); return tgSend(d.html, d.buttons); }
  if (cmd === '/amanha' || cmd === '/semana') {
    const to = addDays(t, cmd === '/amanha' ? 1 : 7), from = cmd === '/amanha' ? to : t;
    const list = occRange(from, to, o => !isDone(o));
    return tgSend(list.length ? `<b>${cmd === '/amanha' ? 'Amanhã' : 'Próximos 7 dias'}:</b>\n${list.map(o => tgLine(o, { withDate: cmd === '/semana' })).join('\n')}` : 'Nada agendado. Agenda livre! 🙌');
  }
  if (cmd === '/contas') {
    const list = [...occRange(addDays(t, -60), addDays(t, -1), o => o.item.kind === 'bill' && !isDone(o)), ...occRange(t, new Date(t.getFullYear(), t.getMonth(), daysIn(t)), o => o.item.kind === 'bill' && !isDone(o))];
    if (!list.length) return tgSend('Nenhuma conta pendente neste mês. ✅');
    return tgSend(`<b>💸 Contas pendentes</b> · total ${brl(list.reduce((s, o) => s + amountOf(o), 0))}\n${list.map(o => tgLine(o, { withDate: true })).join('\n')}`, list.slice(0, 8).map(o => [payBtn(o)]));
  }
  let res;
  if (S.settings.apiKey) { try { res = await aiInterpret(text, S.items, S.settings.apiKey); } catch { res = interpret(text, S.items); } }
  else res = interpret(text, S.items);

  if (res.intent === 'create') {
    const saved = [], missing = [];
    for (const d of res.items) {
      if (!d.title) continue;
      if (d.kind === 'bill' && !d.date && !d.recurrence) { missing.push(d.title); continue; }
      const it = draftToItem(d); await saveItem(it); saved.push(it);
    }
    render(); tick();
    if (!saved.length && !missing.length) return tgSend('Não entendi o que anotar 🤔 Tente com dia e horário, ex.: <i>amanhã às 10h reunião</i>.');
    let html = saved.length ? `📝 <b>Anotado!</b>\n${saved.map(it => { const o = occurrences(it, parseISO(it.date), parseISO(it.date))[0] || { item: it, date: it.date, key: it.recurrence ? it.date : 'once' }; return `${tgLine(o, { withDate: true })}${it.recurrence ? ` · 🔁 ${describeRecurrence(it.recurrence).toLowerCase()}` : ''}`; }).join('\n')}\n\nVou te lembrar na hora certa.` : '';
    if (missing.length) html += `${html ? '\n\n' : ''}Para <b>${tgEsc(missing[0])}</b> preciso do dia do vencimento. Ex.: <i>${tgEsc(missing[0].toLowerCase())} dia 10</i>.`;
    return tgSend(html);
  }
  if (res.intent === 'pay' || res.intent === 'complete') {
    const it = res.target || findItem(text.toLowerCase(), S.items, res.intent === 'pay' ? 'bill' : null);
    if (!it) return tgSend('Não encontrei esse item na sua lista. Quer que eu anote? Me diga o nome e a data.');
    const o = nearestOpenOcc(it);
    if (!o) return tgSend(`<b>${tgEsc(it.title)}</b> já está em dia. ✅`);
    if (res.intent === 'pay') {
      if (res.amount) { it.amounts = it.amounts || {}; it.amounts[o.key] = res.amount; await saveItem(it); }
      return tgSend(`Encontrei <b>${tgEsc(it.title)}</b>, vencimento ${relDay(o.date)} (${fmtDate(o.date)})${amountOf(o) ? `, ${brl(amountOf(o))}` : ''}.\nConfirma que já foi pago?`, [[{ text: '✅ Sim, foi pago', callback_data: `p|${it.id}|${o.date}` }, { text: 'Ainda não', callback_data: 'n' }]]);
    }
    await toggleDone(o, true);
    return tgSend(`✅ Marquei <b>${tgEsc(it.title)}</b> como concluído.`);
  }
  if (res.intent === 'query') {
    const { text: r, list } = answerQuery(res.query);
    return tgSend(`${tgEsc(r)}${list.length ? '\n\n' + list.slice(0, 10).map(o => tgLine(o, { withDate: true })).join('\n') : ''}`, list.filter(o => o.item.kind === 'bill' && !isDone(o)).slice(0, 5).map(o => [payBtn(o)]));
  }
}

async function tgCallback(q) {
  const [act, id, date] = (q.data || '').split('|');
  const answer = text => tg(S.settings.tgToken, 'answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (act === 'n') return answer('Ok, continua pendente.');
  const o = findOcc(id, date);
  if (!o) return answer('Item não encontrado.');
  const it = baseOf(o.item);
  if (isDone(o)) { await answer(act === 'p' ? 'Já estava pago ✅' : 'Já estava concluído ✅'); }
  else if (act === 'p') {
    it.payments = it.payments || {};
    it.payments[o.key] = { paidAt: Date.now(), amount: amountOf(o), via: 'telegram' };
    await saveItem(it);
    await answer('Pagamento confirmado ✅');
    await tgSend(`✅ Pagamento de <b>${tgEsc(it.title)}</b>${amountOf(o) ? ` (${brl(amountOf(o))})` : ''} confirmado.${it.recurrence ? ' Próximo lembrete já agendado.' : ''}`);
  } else if (act === 'd') {
    await toggleDone(o, true);
    await answer('Concluído ✅');
  }
  // tira o botão já usado da mensagem
  const kb = (q.message?.reply_markup?.inline_keyboard || []).map(r => r.filter(b => b.callback_data !== q.data)).filter(r => r.length && !r.some(b => b.callback_data === 'n'));
  tg(S.settings.tgToken, 'editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: kb } }).catch(() => {});
  render(); tick();
}

function tgCardHTML() {
  const st = S.settings;
  const chip = tgReady() ? '<span class="chip paid">Conectado</span>' : st.tgToken ? '<span class="chip soon">Aguardando você</span>' : '<span class="chip neutral">Gratuito</span>';
  let body;
  if (!st.tgToken) body = `
    <p style="color:#c9ced7;font-size:14px;margin-top:0">Receba o resumo das demandas do dia, os lembretes e as contas no Telegram — e anote coisas mandando mensagem para a sua secretária.</p>
    <ol class="tg-steps">
      <li>No Telegram, abra o <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a> e envie <code>/newbot</code>.</li>
      <li>Escolha um nome (ex.: <i>Finantrix Secretária</i>) e um usuário terminado em <i>bot</i> (ex.: <i>finantrix_nay_bot</i>).</li>
      <li>Ele vai te mandar um <b>token</b> (algo como <code>123456:ABC-xyz…</code>). Cole aqui:</li>
    </ol>
    <div class="field"><label>Token do robô</label><input class="inp mono" type="password" id="tg-token" placeholder="123456789:AA..." autocomplete="off"></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary sm" id="tg-connect">Conectar</button></div>`;
  else if (!st.tgChatId) body = `
    <div class="tg-wait"><div class="ai-orb"><i></i><i></i><i></i></div><div><b>Último passo</b><p>Abra <a href="https://t.me/${tgEsc(st.tgBot)}" target="_blank" rel="noopener"><b>@${tgEsc(st.tgBot)}</b></a> no Telegram e toque em <b>Iniciar</b> (ou envie <code>/start</code>). Estou aguardando…</p></div></div>
    <div style="display:flex;gap:8px;margin-top:12px"><a class="btn primary sm" href="https://t.me/${tgEsc(st.tgBot)}?start=finantrix" target="_blank" rel="noopener">Abrir @${tgEsc(st.tgBot)}</a><button class="btn sm ghost" id="tg-off">Cancelar</button></div>`;
  else body = `
    <p style="color:#c9ced7;font-size:14px;margin-top:0">Conectado a <a href="https://t.me/${tgEsc(st.tgBot)}" target="_blank" rel="noopener"><b>@${tgEsc(st.tgBot)}</b></a>. Mande mensagens para ele para anotar, perguntar ou confirmar pagamentos.</p>
    <div class="set-row"><div><b>Resumo do dia</b><p>Compromissos, tarefas e contas do dia.</p></div><div style="display:flex;gap:10px;align-items:center"><input type="time" class="inp" style="width:110px" id="tg-hour" value="${st.tgDailyHour}"><label class="toggle"><input type="checkbox" id="tg-daily" ${st.tgDaily ? 'checked' : ''}><span></span></label></div></div>
    <div class="set-row"><div><b>Prévia de amanhã (19h)</b><p>“Amanhã você tem médico às 14h…”</p></div><label class="toggle"><input type="checkbox" id="tg-eve" ${st.tgEvening ? 'checked' : ''}><span></span></label></div>
    <div class="set-row"><div><b>Lembrete antes do compromisso</b><p>${st.minutesBefore} min antes, com botão “Feito”.</p></div><label class="toggle"><input type="checkbox" id="tg-rem" ${st.tgReminders ? 'checked' : ''}><span></span></label></div>
    <div class="set-row"><div><b>Backup automático</b><p id="tg-bk-info">Cópia de segurança fixada na conversa a cada alteração.</p></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="tg-bk">Fazer backup</button><button class="btn sm" id="tg-rs">Restaurar</button></div></div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary sm" id="tg-now">Enviar resumo agora</button><button class="btn sm danger" id="tg-off">Desconectar</button></div>`;
  return `<div class="card glow"><h3>${icon('send', 16)} Telegram ${chip}</h3>${body}
    <p style="color:var(--muted);font-size:12.5px;margin:12px 0 0">Funciona enquanto o Finantrix estiver aberto neste Mac (pode ficar minimizado). Se o Mac estava desligado no horário, o resumo chega assim que você abrir (até as 18h).</p></div>`;
}
function bindTgCard(v) {
  const set = async (k, val) => { S.settings[k] = val; await saveSettings(); };
  $('#tg-connect', v)?.addEventListener('click', async () => {
    const token = $('#tg-token', v).value.trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) return toast('Token inválido', 'Copie o token completo que o @BotFather enviou.', 'bad');
    try {
      const me = await aiWhile(tg(token, 'getMe'), ['Conectando ao Telegram', 'Validando robô'], 'Conectando Telegram');
      await set('tgToken', token); await set('tgBot', me.username); await set('tgChatId', '');
      await db.setSetting('tgOffset', 0);
      tgRestart(); render();
    } catch (e) { toast('Não consegui conectar', e.message, 'bad'); }
  });
  $('#tg-off', v)?.addEventListener('click', async () => { await set('tgToken', ''); await set('tgBot', ''); await set('tgChatId', ''); tgRestart(); render(); toast('Telegram desconectado', ''); });
  $('#tg-hour', v)?.addEventListener('change', e => set('tgDailyHour', e.target.value || '07:30'));
  $('#tg-daily', v)?.addEventListener('change', e => set('tgDaily', e.target.checked));
  $('#tg-eve', v)?.addEventListener('change', e => set('tgEvening', e.target.checked));
  $('#tg-rem', v)?.addEventListener('change', e => set('tgReminders', e.target.checked));
  $('#tg-bk', v)?.addEventListener('click', async () => { try { await aiWhile(tgBackupNow(false), ['Empacotando seus dados', 'Enviando ao Telegram'], 'Backup'); render(); } catch (e) { toast('Falha no backup', e.message, 'bad'); } });
  $('#tg-rs', v)?.addEventListener('click', () => modal(`<header><h2>Restaurar do Telegram?</h2></header><div class="body"><p style="margin:0;color:#c9ced7">Vou buscar o último backup fixado na conversa e juntar com o que está aqui (nada atual é apagado).</p></div><footer><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="r-go">Restaurar</button></footer>`, { onMount: (m, close) => { $('#r-go', m).onclick = async () => { close(); try { await aiWhile(tgRestore(), ['Buscando backup no Telegram', 'Restaurando dados'], 'Restaurando'); } catch (e) { toast('Falha ao restaurar', e.message, 'bad'); } }; } }));
  db.getSetting('lastBackup', null).then(b => { const el = $('#tg-bk-info', v); if (el && b) el.textContent = `Último: ${new Date(b.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${b.items} itens. Fixado na conversa do robô.`; });
  $('#tg-now', v)?.addEventListener('click', async () => { try { const d = tgDaily(); await tgSend(d.html, d.buttons); toast('Resumo enviado', 'Confira no Telegram.', 'ok'); } catch (e) { toast('Falha ao enviar', e.message, 'bad'); } });
}

/* ------------------------------------------------------------------ FORMULÁRIO */
function itemForm(existing, preset = {}, fromAI = false) {
  const it = existing ? structuredClone(existing) : { id: uid(), kind: preset.kind || 'task', title: '', category: '', date: preset.date || iso(today()), time: null, recurrence: null, amount: null, notes: '', files: [], payments: {}, completions: {}, ...preset };
  if (preset.id && !existing) Object.assign(it, preset);
  let pending = [...(it.files || [])];
  const recType = it.recurrence ? it.recurrence.type : 'none';
  const catOpts = kind => Object.entries(CATEGORIES).filter(([, c]) => c.kind === kind).map(([k, c]) => `<option value="${k}" ${it.category === k ? 'selected' : ''}>${c.label}</option>`).join('');
  const html = `
    <header><h2>${existing ? (existing.recurrence ? 'Editar todos os dias' : 'Editar') : fromAI ? 'Completar anotação' : 'Nova anotação'}</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
    <div class="body">
      <div class="kind-pick" id="f-kind">${[['task', 'check', 'Tarefa'], ['event', 'calendar', 'Compromisso'], ['bill', 'wallet', 'Conta / boleto']].map(([k, ic, l]) => `<button type="button" data-k="${k}" class="${it.kind === k ? 'on' : ''}">${icon(ic, 22)}${l}</button>`).join('')}</div>
      <div class="form-grid mt">
        <div class="field full"><label>Título</label><input class="inp" id="f-title" value="${esc(it.title)}" placeholder="Ex.: Energia, Médico, Comprar remédio"></div>
        <div class="field"><label>Categoria</label><select class="inp" id="f-cat">${catOpts(it.kind)}</select></div>
        <div class="field bill-only"><label>Valor (R$)</label><input class="inp" id="f-amount" inputmode="decimal" value="${it.amount != null ? Number(it.amount).toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></div>
        <div class="field not-bill"><label>Horário</label><input class="inp" type="time" id="f-time" value="${it.time || ''}"></div>
        <div class="field"><label id="f-date-lbl">${it.kind === 'bill' ? 'Vencimento' : 'Data'}</label><input class="inp" type="date" id="f-date" value="${it.date || ''}"></div>
        <div class="field"><label>Repetir</label><select class="inp" id="f-rec">${[['none', 'Não repete'], ['daily', 'Todo dia'], ['weekly', 'Toda semana'], ['monthly', 'Todo mês'], ['yearly', 'Todo ano']].map(([k, l]) => `<option value="${k}" ${recType === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field bill-only full"><label>Código de barras / linha digitável</label><input class="inp mono" id="f-barcode" value="${esc(it.barcode || '')}" placeholder="Cole a linha digitável do boleto"></div>
        <div class="field bill-only full"><label>PIX copia e cola / chave PIX</label><input class="inp mono" id="f-pix" value="${esc(it.pix || '')}" placeholder="Opcional"></div>
        <div class="field full"><label>Observações</label><textarea class="inp" id="f-notes" placeholder="Endereço, beneficiário, instruções…">${esc(it.notes || '')}</textarea></div>
        <div class="field full"><label>Anexos <span class="bill-only">(boleto, fatura, comprovante)</span></label>
          <label class="dropzone" id="f-drop">${icon('clip', 22)}<div style="margin-top:6px">Arraste o PDF ou imagem aqui, ou clique para escolher</div><input type="file" id="f-file" multiple accept="application/pdf,image/*" hidden></label>
          <div class="files" id="f-files"></div></div>
      </div>
    </div>
    <footer>${existing ? `<button class="btn danger left" id="f-del">${icon('trash', 16)} Excluir</button>` : ''}<button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="f-save">${icon('check', 18)} Salvar</button></footer>`;
  modal(html, {
    onMount: (m, close) => {
      const applyKind = () => {
        $$('.bill-only', m).forEach(e => e.style.display = it.kind === 'bill' ? '' : 'none');
        $$('.not-bill', m).forEach(e => e.style.display = it.kind === 'bill' ? 'none' : '');
        $('#f-date-lbl', m).textContent = it.kind === 'bill' ? 'Vencimento' : 'Data';
      };
      applyKind();
      $$('#f-kind button', m).forEach(b => b.onclick = () => { it.kind = b.dataset.k; $$('#f-kind button', m).forEach(x => x.classList.toggle('on', x === b)); $('#f-cat', m).innerHTML = catOpts(it.kind); applyKind(); });
      const drawFiles = () => { $('#f-files', m).innerHTML = pending.map((f, i) => `<span class="file-pill">${icon('file', 15)}<span data-prev="${i}">${esc(f.name)}</span><button data-rm="${i}" aria-label="Remover">${icon('x', 14)}</button></span>`).join('');
        $$('[data-rm]', m).forEach(b => b.onclick = () => { pending.splice(+b.dataset.rm, 1); drawFiles(); });
        $$('[data-prev]', m).forEach(b => b.onclick = () => { const f = pending[+b.dataset.prev]; if (f.id) previewFile(f.id); }); };
      drawFiles();
      const addFiles = async files => { for (const f of files) { const id = await db.saveFile(f); pending.push({ id, name: f.name, type: f.type, key: null, added: true }); } drawFiles(); };
      $('#f-file', m).onchange = e => addFiles(e.target.files);
      const dz = $('#f-drop', m);
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); };
      $('#f-title', m).focus();
      $('#f-save', m).onclick = async () => {
        const title = $('#f-title', m).value.trim();
        if (!title) { $('#f-title', m).focus(); return toast('Dê um título', '', 'bad'); }
        const date = $('#f-date', m).value;
        if (!date) return toast('Informe a data', '', 'bad');
        const rt = $('#f-rec', m).value, d = parseISO(date);
        it.title = title; it.category = $('#f-cat', m).value; it.date = date;
        if (kindOfCategory(it.category) !== it.kind) it.category = DEFAULT_CAT[it.kind];
        it.time = it.kind === 'bill' ? null : ($('#f-time', m).value || null);
        it.amount = it.kind === 'bill' ? (parseFloat($('#f-amount', m).value.replace(/\./g, '').replace(',', '.')) || null) : null;
        it.barcode = it.kind === 'bill' ? $('#f-barcode', m).value.trim() : '';
        it.pix = it.kind === 'bill' ? $('#f-pix', m).value.trim() : '';
        it.notes = $('#f-notes', m).value.trim();
        it.recurrence = rt === 'none' ? null : rt === 'daily' ? { type: 'daily' } : rt === 'weekly' ? { type: 'weekly', weekday: d.getDay() } : rt === 'monthly' ? { type: 'monthly', day: d.getDate() } : { type: 'yearly', day: d.getDate(), month: d.getMonth() };
        it.startDate = it.recurrence ? (existing?.startDate && existing.startDate < date ? existing.startDate : date) : null;
        const removed = (existing?.files || []).filter(f => !pending.some(p => p.id === f.id));
        for (const f of removed) await db.del('files', f.id);
        it.files = pending.map(({ added, ...f }) => f);
        it.createdAt = it.createdAt || Date.now();
        await saveItem(it);
        close(); render(); tick();
        await aiWork(['Gravando no cofre local', 'Agendando lembretes'], 500, 'Salvando');
        toast(existing ? 'Atualizado' : 'Anotado ✓', `${it.title} · ${it.recurrence ? describeRecurrence(it.recurrence) : fmtDate(it.date)}`, 'ok');
      };
      $('#f-del', m)?.addEventListener('click', async () => { await deleteItem(it.id); close(); render(); tick(); toast('Excluído', it.title, 'ok'); });
      m.parentElement.addEventListener('mousedown', async e => { if (e.target === m.parentElement && !existing) for (const f of pending.filter(p => p.added)) await db.del('files', f.id); });
    }
  });
}

/* ------------------------------------------------------------------ EXCLUIR */
function deleteFlow(o, wholeOnly = false) {
  const it = baseOf(o.item), rec = !!it.recurrence && !wholeOnly;
  const what = it.kind === 'bill' ? 'esta conta' : it.kind === 'event' ? 'este compromisso' : 'esta tarefa';
  modal(`<header><h2>Excluir ${esc(it.title)}?</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
    <div class="body"><div class="detail-head">${catIcon(it.category, 22)}<div><b>${esc(it.title)}</b><div class="r-meta"><span>${it.recurrence ? describeRecurrence(it.recurrence) : fmtDate(it.date || o.date, { day: '2-digit', month: 'long' })}</span></div></div></div>
    <p style="color:var(--muted);margin:16px 0 0">${rec ? `Este item se repete (${describeRecurrence(it.recurrence).toLowerCase()}). Você quer excluir só o dia ${fmtDate(o.date, { day: '2-digit', month: 'long' })} ou todas as repetições?` : `Vou apagar ${what} e seus anexos. Não dá para desfazer.`}</p></div>
    <footer><button class="btn ghost" data-close>Cancelar</button>${rec ? `<button class="btn" id="x-one">Só este dia</button>` : ''}<button class="btn danger" id="x-all">${icon('trash', 16)} ${rec ? 'Excluir todas' : 'Excluir'}</button></footer>`, {
    onMount: (m, close) => {
      $('#x-one', m)?.addEventListener('click', async () => { it.skips = [...(it.skips || []), o.date]; await saveItem(it); close(); render(); tick(); toast('Removido deste dia', `${it.title} · ${fmtDate(o.date)}`, 'ok'); });
      $('#x-all', m).onclick = async () => { await deleteItem(it.id); close(); render(); tick(); toast('Excluído', it.title, 'ok'); };
    }
  });
}

/* ------------------------------------------------------------------ EDITAR SÓ UM DIA */
// Muda só a data escolhida de um item que se repete; o resto da série fica intacto.
function dayEditForm(o) {
  const base = baseOf(o.item), view = o.item, isBill = base.kind === 'bill';
  const dayFiles = (base.files || []).filter(f => f.key === o.key);
  const added = [];
  const curAmount = amountOf(o);
  modal(`
    <header><h2>Editar só ${fmtDate(o.date, { weekday: 'short', day: '2-digit', month: 'short' })}</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
    <div class="body">
      <div class="edited-box">${icon('repeat', 15)}<span>Série: <b>${esc(base.title)}</b> · ${describeRecurrence(base.recurrence)}. O que você mudar aqui vale <b>só para este dia</b>.</span></div>
      <div class="form-grid mt">
        <div class="field full"><label>Título neste dia</label><input class="inp" id="e-title" value="${esc(view.title)}"></div>
        ${isBill ? `<div class="field"><label>Valor deste mês (R$)</label><input class="inp" id="e-amount" inputmode="decimal" value="${curAmount ? Number(curAmount).toFixed(2).replace('.', ',') : ''}"></div>`
                 : `<div class="field"><label>Horário neste dia</label><input class="inp" type="time" id="e-time" value="${view.time || ''}"></div>`}
        <div class="field full"><label>Observações deste dia</label><textarea class="inp" id="e-notes" placeholder="Ex.: levar exames, falar com a Ana, pauta da reunião…">${esc(view.notes || '')}</textarea></div>
        <div class="field full"><label>Anexos deste dia</label>
          <label class="dropzone" id="e-drop">${icon('clip', 20)}<div>Arraste ou clique para anexar</div><input type="file" id="e-file" multiple accept="application/pdf,image/*" hidden></label>
          <div class="files" id="e-files"></div></div>
      </div>
    </div>
    <footer><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="e-save">${icon('check', 18)} Salvar só este dia</button></footer>`, {
    onMount: (m, close) => {
      const draw = () => {
        $('#e-files', m).innerHTML = dayFiles.map((f, i) => `<span class="file-pill">${icon('file', 15)}<span data-prev="${f.id}">${esc(f.name)}</span><button data-rm="${i}" aria-label="Remover">${icon('x', 14)}</button></span>`).join('');
        $$('[data-rm]', m).forEach(b => b.onclick = () => { dayFiles.splice(+b.dataset.rm, 1); draw(); });
        $$('[data-prev]', m).forEach(b => b.onclick = () => previewFile(b.dataset.prev));
      };
      draw();
      const addFiles = async files => { for (const f of files) { const id = await db.saveFile(f); const rec = { id, name: f.name, type: f.type, key: o.key }; added.push(rec); dayFiles.push(rec); } draw(); };
      $('#e-file', m).onchange = e => addFiles(e.target.files);
      const dz = $('#e-drop', m);
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
      dz.ondragleave = () => dz.classList.remove('over');
      dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); };
      $('#e-save', m).onclick = async () => {
        const next = {};
        const title = $('#e-title', m).value.trim(), notes = $('#e-notes', m).value.trim();
        if (title && title !== base.title) next.title = title;
        if (notes !== (base.notes || '')) next.notes = notes;
        if (!isBill) { const t = $('#e-time', m).value || null; if (t !== (base.time || null)) next.time = t; }
        base.overrides = base.overrides || {};
        if (Object.keys(next).length) base.overrides[o.date] = next; else delete base.overrides[o.date];
        if (isBill) {
          const v = parseFloat($('#e-amount', m).value.replace(/\./g, '').replace(',', '.'));
          base.amounts = base.amounts || {};
          if (isFinite(v) && v !== Number(base.amount)) base.amounts[o.key] = v; else delete base.amounts[o.key];
        }
        const keep = new Set(dayFiles.map(f => f.id));
        for (const f of (base.files || []).filter(f => f.key === o.key && !keep.has(f.id))) await db.del('files', f.id);
        base.files = [...(base.files || []).filter(f => f.key !== o.key), ...dayFiles];
        await saveItem(base);
        close(); render(); tick();
        toast('Salvo só neste dia', `${title || base.title} · ${fmtDate(o.date)}. O resto da série não mudou.`, 'ok');
      };
      m.parentElement.addEventListener('mousedown', async e => { if (e.target === m.parentElement) for (const f of added) await db.del('files', f.id); });
    }
  });
}

/* ------------------------------------------------------------------ DETALHE */
function detailModal(o) {
  const it = o.item, base = baseOf(it), c = cat(it.category), st = status(o), done = isDone(o), pay = it.payments?.[o.key];
  const files = (it.files || []).filter(f => !f.key || f.key === o.key);
  const hist = it.kind === 'bill' ? Object.entries(it.payments || {}).sort((a, b) => b[0].localeCompare(a[0])) : [];
  const html = `
    <header><div class="detail-head">${catIcon(it.category, 26)}<div><h2>${esc(it.title)}</h2><div class="r-meta"><span>${c.label}</span><span>${it.kind === 'bill' ? 'Conta' : it.kind === 'event' ? 'Compromisso' : 'Tarefa'}</span></div></div></div><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
    <div class="body">
      ${it.kind === 'bill' ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><div class="detail-amount">${amountOf(o) ? brl(amountOf(o)) : 'Valor não informado'}</div>${statusChip(o)}</div>` : `<div>${statusChip(o)}</div>`}
      <div class="kv">
        <div><small>${it.kind === 'bill' ? 'Vencimento' : 'Data'}</small><b>${fmtDate(o.date, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</b></div>
        <div><small>${it.kind === 'bill' ? 'Situação' : 'Horário'}</small><b>${it.kind === 'bill' ? (pay ? `Pago em ${new Date(pay.paidAt).toLocaleDateString('pt-BR')}` : relDay(o.date)) : (it.time || 'Dia todo')}</b></div>
        <div><small>Repetição</small><b>${describeRecurrence(it.recurrence)}</b></div>
      </div>
      ${it.barcode ? `<div class="lbl" style="margin-bottom:6px">Linha digitável</div><div class="code-box"><span>${esc(it.barcode)}</span><button class="btn sm" data-copy="${esc(it.barcode)}">${icon('copy', 14)} Copiar</button></div>` : ''}
      ${it.pix ? `<div class="lbl" style="margin:12px 0 6px">PIX</div><div class="code-box"><span>${esc(it.pix)}</span><button class="btn sm" data-copy="${esc(it.pix)}">${icon('copy', 14)} Copiar</button></div>` : ''}
      ${o.edited ? `<div class="edited-box">${icon('edit', 15)}<span>Este dia tem alterações próprias — o resto da série continua igual.</span><button class="btn sm ghost" id="d-reset">Restaurar padrão</button></div>` : ''}
      ${it.notes ? `<p style="color:#c9ced7;white-space:pre-wrap">${esc(it.notes)}</p>` : ''}
      <div class="lbl" style="margin:16px 0 6px">${it.kind === 'bill' ? 'Boletos e comprovantes' : 'Anexos'}</div>
      <div class="files">${files.map(f => `<span class="file-pill">${icon('file', 15)}<span data-prev="${f.id}">${esc(f.name)}</span>${f.key ? '<em class="chip neutral" style="height:18px">deste mês</em>' : ''}</span>`).join('') || '<span style="color:var(--muted);font-size:13px">Nenhum anexo.</span>'}</div>
      <label class="dropzone mt" id="d-drop">${icon('clip', 18)} ${it.kind === 'bill' && it.recurrence ? 'Anexar boleto deste mês' : 'Anexar arquivo'}<input type="file" id="d-file" accept="application/pdf,image/*" multiple hidden></label>
      ${hist.length ? `<div class="lbl" style="margin:16px 0 6px">Histórico de pagamentos</div><div class="hist">${hist.map(([k, p]) => `<div><span>${k === 'once' ? 'Pagamento' : fmtDate(k, { month: 'long', year: 'numeric' })}</span><span>${p.amount != null ? brl(p.amount) : ''} · ${new Date(p.paidAt).toLocaleDateString('pt-BR')}</span></div>`).join('')}</div>` : ''}
    </div>
    <footer>
      <button class="btn danger left" id="d-del">${icon('trash', 16)} Excluir</button>
      ${it.recurrence ? `<button class="btn" id="d-edit-day">${icon('edit', 16)} Editar só este dia</button><button class="btn ghost" id="d-edit">${icon('repeat', 16)} Editar todos</button>` : `<button class="btn ghost" id="d-edit">${icon('edit', 16)} Editar</button>`}
      ${it.recurrence && !done ? `<button class="btn ghost" id="d-skip">Pular esta</button>` : ''}
      ${it.kind === 'bill' ? (done ? `<button class="btn danger" id="d-unpay">Desfazer pagamento</button>` : `<button class="btn ok" id="d-pay">${icon('check', 18)} Marcar como pago</button>`)
        : `<button class="btn ${done ? 'ghost' : 'ok'}" id="d-done">${icon('check', 18)} ${done ? 'Reabrir' : 'Concluir'}</button>`}
    </footer>`;
  modal(html, {
    onMount: (m, close) => {
      $$('[data-copy]', m).forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado', 'Cole no app do seu banco.', 'ok'); });
      $$('[data-prev]', m).forEach(b => b.onclick = () => previewFile(b.dataset.prev));
      $('#d-file', m).onchange = async e => { for (const f of e.target.files) { const id = await db.saveFile(f); base.files = base.files || []; base.files.push({ id, name: f.name, type: f.type, key: it.recurrence ? o.key : null }); } await saveItem(base); close(); detailModal(findOcc(it.id, o.date)); render(); toast('Anexo salvo', '', 'ok'); };
      $('#d-edit', m).onclick = () => { close(); itemForm(base); };
      $('#d-edit-day', m)?.addEventListener('click', () => { close(); dayEditForm(o); });
      $('#d-reset', m)?.addEventListener('click', async () => { delete base.overrides[o.date]; if (base.amounts) delete base.amounts[o.key]; await saveItem(base); close(); render(); tick(); toast('Dia restaurado', `${base.title} · ${fmtDate(o.date)} voltou ao padrão da série.`, 'ok'); });
      $('#d-del', m).onclick = () => { close(); deleteFlow(o); };
      $('#d-pay', m)?.addEventListener('click', () => { close(); payFlow(o); });
      $('#d-unpay', m)?.addEventListener('click', async () => { delete base.payments[o.key]; await saveItem(base); close(); render(); tick(); toast('Pagamento desfeito', it.title); });
      $('#d-done', m)?.addEventListener('click', async () => { close(); await toggleDone(o); });
      $('#d-skip', m)?.addEventListener('click', async () => { base.skips = [...(base.skips || []), o.date]; await saveItem(base); close(); render(); tick(); toast('Ocorrência pulada', `${it.title} · ${fmtDate(o.date)}`); });
    }
  });
}

async function previewFile(id) {
  const f = await db.fileURL(id); if (!f) return toast('Arquivo não encontrado', '', 'bad');
  const isImg = f.type.startsWith('image/'), isPdf = f.type === 'application/pdf';
  modal(`<header><h2 style="font-size:16px">${esc(f.name)}</h2><div style="display:flex;gap:8px"><a class="btn sm" href="${f.url}" download="${esc(f.name)}">${icon('download', 15)} Baixar</a><button class="icon-btn" data-close>${icon('x')}</button></div></header>
    <div class="body">${isImg ? `<img class="preview-img" src="${f.url}" alt="">` : isPdf ? `<iframe class="preview-frame" src="${f.url}"></iframe>` : `<div class="empty">Pré-visualização indisponível. Use “Baixar”.</div>`}</div>`, { wide: true });
}

/* ------------------------------------------------------------------ PAGAMENTO (o "OK" de confirmação) */
function payFlow(o, presetAmount) {
  const it = baseOf(o.item);
  const html = `
    <header><h2>Confirmar pagamento</h2><button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button></header>
    <div class="body" id="p-body">
      <div class="detail-head">${catIcon(it.category, 24)}<div><b style="font-size:18px">${esc(it.title)}</b><div class="r-meta"><span>Vencimento ${fmtDate(o.date, { day: '2-digit', month: 'long' })}</span>${statusChip(o)}</div></div></div>
      <div class="form-grid mt">
        <div class="field"><label>Valor pago (R$)</label><input class="inp" id="p-amount" inputmode="decimal" value="${(presetAmount || amountOf(o)) ? Number(presetAmount || amountOf(o)).toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></div>
        <div class="field"><label>Data do pagamento</label><input class="inp" type="date" id="p-date" value="${iso(today())}"></div>
        <div class="field full"><label>Comprovante (opcional)</label><label class="dropzone" id="p-drop">${icon('clip', 18)} <span id="p-fname">Anexar comprovante</span><input type="file" id="p-file" accept="application/pdf,image/*" hidden></label></div>
      </div>
    </div>
    <footer><button class="btn ghost" data-close>Ainda não paguei</button><button class="btn ok" id="p-ok">${icon('check', 18)} OK, foi pago</button></footer>`;
  modal(html, {
    onMount: (m, close) => {
      let receipt = null;
      $('#p-file', m).onchange = e => { receipt = e.target.files[0]; $('#p-fname', m).textContent = receipt ? receipt.name : 'Anexar comprovante'; };
      $('#p-ok', m).onclick = async () => {
        const amount = parseFloat($('#p-amount', m).value.replace(/\./g, '').replace(',', '.'));
        let receiptId = null;
        if (receipt) { receiptId = await db.saveFile(receipt); it.files = it.files || []; it.files.push({ id: receiptId, name: 'Comprovante · ' + receipt.name, type: receipt.type, key: o.key }); }
        it.payments = it.payments || {};
        it.payments[o.key] = { paidAt: parseISO($('#p-date', m).value || iso(today())).getTime() + 12 * 3600e3, amount: isFinite(amount) ? amount : amountOf(o), receiptId };
        await saveItem(it);
        $('#p-body', m).innerHTML = `<div class="success"><div class="tick">${icon('check', 40)}</div><h2 style="margin:0">Pagamento confirmado</h2><p style="color:var(--muted);margin:0">${esc(it.title)} · ${brl(it.payments[o.key].amount)}<br>${it.recurrence ? 'Próximo lembrete já agendado.' : 'Conta quitada.'}</p></div>`;
        m.querySelector('footer').innerHTML = `<button class="btn primary" data-close-ok>Fechar</button>`;
        m.querySelector('[data-close-ok]').onclick = close;
        chime(); render(); tick();
        speak(`Pagamento de ${it.title} confirmado.`, S.settings.voiceReply && S.route === 'secretaria');
        setTimeout(close, 2600);
      };
    }
  });
}

/* ------------------------------------------------------------------ ALERTAS */
const alertHTML = a => `<div class="alert ${a.level}" data-alert="${a.itemId}|${a.date}"><span class="a-ic">${icon(a.kind === 'bill' ? 'wallet' : a.level === 'bad' ? 'alert' : 'bell', 18)}</span><div><b>${esc(a.head)}</b><p>${esc(a.body)}</p></div></div>`;
function bindAlerts(root) { $$('[data-alert]', root).forEach(el => el.onclick = () => { const [id, d] = el.dataset.alert.split('|'); const o = findOcc(id, d); if (o) { closeDrawer(); detailModal(o); } }); }
function updateBadge() {
  const n = computeAlerts(S.items, S.settings).length;
  const b = $('#bell-badge'); b.hidden = !n; b.textContent = n > 9 ? '9+' : n;
  document.title = n ? `(${n}) Finantrix` : 'Finantrix — Secretária Virtual';
  if ('setAppBadge' in navigator) { try { n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch {} }
}
async function tick() {
  const alerts = computeAlerts(S.items, S.settings);
  const fired = [];
  await fireAlerts(alerts, { sound: S.settings.sound, onFire: a => fired.push(a) });
  if (fired.length > 2) toast(`${fired.length} novos alertas`, fired.slice(0, 3).map(a => a.head).join(' · '), fired.some(a => a.level === 'bad') ? 'bad' : 'info', { label: 'Abrir central', fn: openDrawer });
  else fired.forEach(a => { const o = findOcc(a.itemId, a.date); toast(a.head, a.body, a.level === 'bad' ? 'bad' : 'info', o ? (a.kind === 'bill' ? { label: 'Já paguei', fn: () => payFlow(o) } : { label: 'Ver', fn: () => detailModal(o) }) : null); });
  updateBadge();
  if (!$('#drawer').hidden) openDrawer();
  tgJobs(alerts).catch(e => console.warn('Telegram', e));
}
function openDrawer() {
  const alerts = computeAlerts(S.items, S.settings);
  $('#drawer-body').innerHTML = alerts.length ? alerts.map(alertHTML).join('') : `<div class="empty"><b>Tudo tranquilo</b>Nenhum alerta agora.</div>`;
  bindAlerts($('#drawer-body'));
  $('#drawer').hidden = false; $('#scrim').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; }

/* ------------------------------------------------------------------ VOZ */
let rec = null, audioStop = null;
async function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voz indisponível neste navegador', 'Use Google Chrome, Edge ou Safari. Você ainda pode digitar.', 'bad'); location.hash = '#/secretaria'; return; }
  const ov = $('#voice-ov'), txt = $('#vo-text'), st = $('#vo-status');
  ov.hidden = false; txt.className = 'vo-text hint'; txt.textContent = 'Fale naturalmente. Ex.: “Amanhã tenho médico às 14h” ou “Conta de luz todo dia 15, 180 reais”.';
  st.textContent = 'OUVINDO…';
  let finalText = '', cancelled = false, silence = null;
  rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
  rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript + ' '; else interim += r[0].transcript; }
    txt.className = 'vo-text'; txt.textContent = (finalText + interim).trim();
    clearTimeout(silence); silence = setTimeout(() => rec && rec.stop(), 2400);
  };
  rec.onerror = e => { if (e.error === 'not-allowed') toast('Microfone bloqueado', 'Permita o uso do microfone para este site.', 'bad'); else if (e.error !== 'no-speech' && e.error !== 'aborted') toast('Erro no reconhecimento de voz', e.error, 'bad'); };
  rec.onend = () => {
    clearTimeout(silence); audioStop && audioStop(); ov.hidden = true; rec = null;
    const t = (finalText || (txt.className === 'vo-text' ? txt.textContent : '')).trim();
    if (!cancelled && t) handleUtterance(t);
  };
  $('#vo-done').onclick = () => { st.textContent = 'PROCESSANDO…'; rec && rec.stop(); };
  $('#vo-cancel').onclick = $('#vo-close').onclick = () => { cancelled = true; rec && rec.abort(); };
  try { rec.start(); } catch (e) { console.warn(e); }
  audioStop = await waveform($('#vo-wave'));
}
async function waveform(canvas) {
  const ctx = canvas.getContext('2d'); let raf, stream, actx, an, data;
  const dpr = window.devicePixelRatio || 1; canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); actx = new AudioContext(); an = actx.createAnalyser(); an.fftSize = 256; actx.createMediaStreamSource(stream).connect(an); data = new Uint8Array(an.frequencyBinCount); } catch { an = null; }
  const N = 48;
  const draw = t => {
    const W = canvas.width, H = canvas.height; ctx.clearRect(0, 0, W, H);
    if (an) an.getByteFrequencyData(data);
    const g = ctx.createLinearGradient(0, 0, W, 0); g.addColorStop(0, '#5ce1ff'); g.addColorStop(.5, '#FFEE32'); g.addColorStop(1, '#FFC600');
    ctx.fillStyle = g; ctx.shadowColor = '#FFEE32'; ctx.shadowBlur = 12 * dpr;
    const bw = W / N;
    for (let i = 0; i < N; i++) {
      const v = an ? data[Math.floor(i / N * data.length * .7)] / 255 : (Math.sin(t / 220 + i * .5) * .5 + .5) * .35;
      const h = Math.max(4 * dpr, v * H * .9);
      const x = i * bw + bw * .25, w = bw * .5;
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, (H - h) / 2, w, h, w / 2) : ctx.rect(x, (H - h) / 2, w, h); ctx.fill();
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(raf); stream && stream.getTracks().forEach(t => t.stop()); actx && actx.close(); };
}

/* ------------------------------------------------------------------ chrome */
function bindChrome() {
  window.addEventListener('hashchange', () => route());
  $('#btn-add').onclick = () => itemForm(null, S.route === 'financas' ? { kind: 'bill' } : {});
  $('#btn-bell').onclick = openDrawer;
  $('#drawer-close').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;
  $('#voice-fab').onclick = () => startVoice();
  $('#ai-mode').textContent = S.settings.apiKey ? 'Online · Claude' : 'Online · local';
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); startVoice(); } });
  navigator.serviceWorker?.addEventListener('message', async e => {
    if (e.data?.type !== 'notif-action') return;
    const { action, data } = e.data; const o = findOcc(data.itemId, data.date); if (!o) return;
    if (action === 'pay') payFlow(o); else if (action === 'done') { if (!isDone(o)) await toggleDone(o); } else detailModal(o);
  });
}
function clock() { const el = $('#clock'); const upd = () => el.textContent = new Date().toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).toUpperCase(); upd(); setInterval(upd, 15000); }
function particles() {
  const c = $('#particles'), ctx = c.getContext('2d'); let W, H; const P = [];
  const size = () => { W = c.width = innerWidth; H = c.height = innerHeight; };
  size(); addEventListener('resize', size);
  for (let i = 0; i < 46; i++) P.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .18, vy: (Math.random() - .5) * .18, r: Math.random() * 1.4 + .3 });
  const loop = () => {
    ctx.clearRect(0, 0, W, H);
    for (const p of P) { p.x = (p.x + p.vx + W) % W; p.y = (p.y + p.vy + H) % H; ctx.fillStyle = 'rgba(255,238,50,.55)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) { const a = P[i], b = P[j], d = Math.hypot(a.x - b.x, a.y - b.y); if (d < 120) { ctx.strokeStyle = `rgba(255,238,50,${.08 * (1 - d / 120)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); } }
    requestAnimationFrame(loop);
  };
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) loop();
}

/* ------------------------------------------------------------------ exemplos */
async function loadDemo() {
  const t = today(), d = n => iso(addDays(t, n));
  const mk = (o) => ({ id: uid(), files: [], payments: {}, completions: {}, notes: '', time: null, recurrence: null, amount: null, createdAt: Date.now(), ...o });
  const monthly = (day) => ({ type: 'monthly', day });
  const firstOf = iso(new Date(t.getFullYear(), t.getMonth() - 3, 1));
  const demo = [
    mk({ kind: 'bill', title: 'Energia', category: 'energia', amount: 186.4, recurrence: monthly(15), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'Aluguel', category: 'moradia', amount: 1650, recurrence: monthly(5), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'Internet Fibra', category: 'internet', amount: 99.9, recurrence: monthly(t.getDate() + 2 > 28 ? 28 : t.getDate() + 2), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'Água', category: 'agua', amount: 78.3, recurrence: monthly(Math.max(1, t.getDate() - 2)), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'Netflix', category: 'assinatura', amount: 55.9, recurrence: monthly(22), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'Cartão de crédito', category: 'cartao', amount: 1240.75, recurrence: monthly(10), date: firstOf, startDate: firstOf }),
    mk({ kind: 'bill', title: 'IPVA', category: 'impostos', amount: 980, date: d(12) }),
    mk({ kind: 'event', title: 'Médico — check-up', category: 'saude', date: d(1), time: '14:00' }),
    mk({ kind: 'event', title: 'Reunião com cliente', category: 'trabalho', date: d(0), time: '16:30' }),
    mk({ kind: 'event', title: 'Academia', category: 'saude', recurrence: { type: 'weekly', weekday: 1 }, date: d(0), startDate: d(-30), time: '07:00' }),
    mk({ kind: 'task', title: 'Comprar remédios', category: 'compras', date: d(0) }),
    mk({ kind: 'task', title: 'Renovar seguro do carro', category: 'tarefa', date: d(4) }),
    mk({ kind: 'event', title: 'Aniversário da mãe', category: 'social', recurrence: { type: 'yearly', day: addDays(t, 9).getDate(), month: addDays(t, 9).getMonth() }, date: d(9), startDate: d(9) }),
  ];
  // histórico: meses anteriores pagos; deixa a Água deste mês vencida para demonstrar
  for (const it of demo.filter(i => i.kind === 'bill' && i.recurrence)) {
    const occ = occurrences(it, parseISO(firstOf), addDays(t, -1));
    occ.forEach((o, idx) => {
      if (it.title === 'Água' && idx === occ.length - 1) return;
      it.payments[o.key] = { paidAt: parseISO(o.date).getTime(), amount: Math.round(it.amount * (0.9 + Math.random() * 0.2) * 100) / 100 };
    });
  }
  for (const it of demo) await saveItem(it);
}

boot();
