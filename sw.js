// Finantrix — service worker: cache offline + ações das notificações.
const CACHE = 'finantrix-v3';
const ASSETS = ['./', './index.html', './css/styles.css', './js/app.js', './js/core.js', './js/db.js', './js/parser.js', './js/notify.js', './js/ai.js', './js/icons.js', './js/mark-path.js',
  './assets/img/logo-dark.svg', './assets/img/mark.svg', './assets/img/icon-192.png', './assets/img/favicon.png',
  './assets/fonts/Neusharp-Regular.woff2', './assets/fonts/Neusharp-Medium.woff2', './assets/fonts/Neusharp-Bold.woff2', './assets/fonts/Neusharp-Black.woff2', './assets/fonts/Neusharp-Light.woff2', './assets/fonts/Neusharp-SemiBold.woff2'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

// Rede primeiro (para sempre pegar a versão nova), cache como reserva offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const action = e.action || 'open';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = all[0];
    if (client) { await client.focus(); }
    else { client = await self.clients.openWindow('./index.html#/painel'); }
    if (client) client.postMessage({ type: 'notif-action', action, data });
  })());
});
