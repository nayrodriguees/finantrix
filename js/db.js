// Finantrix — armazenamento local (IndexedDB). Tudo fica no seu computador.
const DB_NAME = 'finantrix';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('notified')) db.createObjectStore('notified', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async all(store) { return tx(store, 'readonly', s => reqP(s.getAll())); },
  async get(store, key) { return tx(store, 'readonly', s => reqP(s.get(key))); },
  async put(store, val) { return tx(store, 'readwrite', s => reqP(s.put(val))); },
  async del(store, key) { return tx(store, 'readwrite', s => reqP(s.delete(key))); },
  async clear(store) { return tx(store, 'readwrite', s => reqP(s.clear())); },

  async getSetting(k, def = null) { const r = await this.get('kv', k); return r ? r.v : def; },
  async setSetting(k, v) { return this.put('kv', { k, v }); },

  async saveFile(file) {
    const id = uid();
    const buf = await file.arrayBuffer();
    await this.put('files', { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, data: buf, createdAt: Date.now() });
    return id;
  },
  async fileURL(id) {
    const f = await this.get('files', id);
    if (!f) return null;
    return { url: URL.createObjectURL(new Blob([f.data], { type: f.type })), name: f.name, type: f.type, size: f.size };
  },

  async exportAll() {
    const [items, files, kv] = await Promise.all([this.all('items'), this.all('files'), this.all('kv')]);
    const enc = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
    return JSON.stringify({ app: 'finantrix', version: 1, exportedAt: new Date().toISOString(),
      items, kv: kv.filter(x => x.k !== 'apiKey'),
      files: files.map(f => ({ ...f, data: enc(f.data) })) });
  },
  async importAll(json) {
    const d = JSON.parse(json);
    if (d.app !== 'finantrix') throw new Error('Arquivo de backup inválido');
    const dec = s => { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b.buffer; };
    for (const it of d.items || []) await this.put('items', it);
    for (const f of d.files || []) await this.put('files', { ...f, data: dec(f.data) });
    for (const k of d.kv || []) await this.put('kv', k);
  }
};
