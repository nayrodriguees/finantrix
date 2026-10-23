// Finantrix — motor de alertas: calcula o que avisar e dispara notificações do sistema.
import { db } from './db.js';
import { iso, allOccurrences, today, addDays, parseISO, diffDays, isDone, amountOf, brl, cat, WEEKDAYS } from './core.js';

let swReg = null;
export async function initSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { swReg = await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('SW', e); }
  return swReg;
}

export const notifSupported = () => 'Notification' in window;
export const notifPermission = () => notifSupported() ? Notification.permission : 'unsupported';
export async function requestPermission() { if (!notifSupported()) return 'unsupported'; return Notification.requestPermission(); }

// Gera a lista de alertas ativos agora (usada pela central de notificações e pelo disparo).
export function computeAlerts(items, settings, now = new Date()) {
  const t0 = today();
  const occs = allOccurrences(items, addDays(t0, -60), addDays(t0, 7));
  const alerts = [];
  const billDays = settings.billDaysBefore ?? 3;
  const minutesBefore = settings.minutesBefore ?? 30;
  const [dh, dm] = (settings.dailyHour || '08:00').split(':').map(Number);
  const afterDaily = now.getHours() * 60 + now.getMinutes() >= dh * 60 + dm;

  for (const o of occs) {
    if (isDone(o)) continue;
    const it = o.item;
    const n = diffDays(parseISO(o.date), t0);
    const c = cat(it.category);
    const base = { itemId: it.id, date: o.date, key: o.key, kind: it.kind, category: it.category, title: it.title };

    if (it.kind === 'bill') {
      const v = amountOf(o) ? ` · ${brl(amountOf(o))}` : '';
      if (n < 0 && afterDaily) alerts.push({ ...base, rule: `overdue-${iso0(t0)}`, level: 'bad', head: `Conta vencida: ${it.title}`, body: `Venceu ${-n === 1 ? 'ontem' : `há ${-n} dias`}${v}. Já pagou? Confirme no Finantrix.` });
      else if (n === 0 && afterDaily) alerts.push({ ...base, rule: 'due-today', level: 'warn', head: `Vence hoje: ${it.title}`, body: `Não esqueça de pagar${v}.` });
      else if (n > 0 && n <= billDays && afterDaily) alerts.push({ ...base, rule: `due-${n}`, level: n === 1 ? 'warn' : 'info', head: `${it.title} vence ${n === 1 ? 'amanhã' : `em ${n} dias`}`, body: `Vencimento ${WEEKDAYS[parseISO(o.date).getDay()]}${v}.` });
    } else {
      const hora = it.time ? ` às ${it.time}` : '';
      if (n === 1 && now.getHours() >= 18) alerts.push({ ...base, rule: 'eve', level: 'info', head: `Amanhã você tem: ${it.title}`, body: `${c.label}${hora}. Já deixei anotado pra você.` });
      if (n === 1 && afterDaily) alerts.push({ ...base, rule: 'tomorrow', level: 'info', head: `Amanhã: ${it.title}`, body: `${c.label}${hora}.` });
      if (n === 0 && afterDaily) alerts.push({ ...base, rule: 'today', level: 'warn', head: `Hoje: ${it.title}`, body: it.time ? `Às ${it.time}.` : 'Está na sua agenda de hoje.' });
      if (n === 0 && it.time) {
        const [h, m] = it.time.split(':').map(Number);
        const mins = h * 60 + m - (now.getHours() * 60 + now.getMinutes());
        if (mins <= minutesBefore && mins > -5) alerts.push({ ...base, rule: 'soon', level: 'bad', head: `Em ${Math.max(0, mins)} min: ${it.title}`, body: `Começa às ${it.time}.` });
      }
      if (n < 0 && n >= -7 && it.kind === 'task' && afterDaily) alerts.push({ ...base, rule: `late-${iso0(t0)}`, level: 'bad', head: `Tarefa atrasada: ${it.title}`, body: `Era para ${-n === 1 ? 'ontem' : `${-n} dias atrás`}.` });
    }
  }
  // "eve" e "tomorrow" são redundantes: mantém só um por item
  const seen = new Set();
  return alerts.filter(a => { if (a.rule === 'tomorrow' && alerts.some(b => b.rule === 'eve' && b.itemId === a.itemId && b.date === a.date)) return false; const k = a.itemId + a.date + a.rule; if (seen.has(k)) return false; seen.add(k); return true; })
               .sort((a, b) => ({ bad: 0, warn: 1, info: 2 }[a.level] - { bad: 0, warn: 1, info: 2 }[b.level]));
}
const iso0 = d => iso(d);

const alertId = a => `${a.itemId}|${a.date}|${a.rule}`;

// Dispara notificações novas (uma vez por regra) e retorna quantas.
export async function fireAlerts(alerts, { sound = true, onFire } = {}) {
  let count = 0;
  for (const a of alerts) {
    const id = alertId(a);
    if (await db.get('notified', id)) continue;
    await db.put('notified', { id, at: Date.now() });
    count++;
    onFire && onFire(a);
    if (notifPermission() === 'granted') {
      const opts = {
        body: a.body, icon: './assets/img/icon-192.png', badge: './assets/img/favicon.png', tag: id,
        data: { itemId: a.itemId, date: a.date, key: a.key, kind: a.kind },
        requireInteraction: a.level === 'bad',
        actions: a.kind === 'bill' ? [{ action: 'pay', title: '✓ Já paguei' }, { action: 'open', title: 'Abrir' }] : [{ action: 'done', title: '✓ Concluído' }, { action: 'open', title: 'Abrir' }]
      };
      try {
        if (swReg && swReg.showNotification) await swReg.showNotification(a.head, opts);
        else new Notification(a.head, opts);
      } catch (e) { try { new Notification(a.head, { body: a.body, icon: opts.icon }); } catch {} }
    }
  }
  if (count && sound) chime();
  return count;
}

let actx = null;
export function chime() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    [880, 1318.5, 1760].forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09); g.gain.linearRampToValueAtTime(0.12, t + i * 0.09 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.6);
      o.connect(g).connect(actx.destination); o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.7);
    });
  } catch {}
}

// Fala da secretária (síntese de voz do navegador)
export function speak(text, enabled = true) {
  if (!enabled || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'pt-BR'; u.rate = 1.04; u.pitch = 1.05;
  const voices = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('pt'));
  const pref = voices.find(v => /luciana|francisca|female|feminina|google português/i.test(v.name)) || voices.find(v => /br/i.test(v.lang)) || voices[0];
  if (pref) u.voice = pref;
  speechSynthesis.speak(u);
}
