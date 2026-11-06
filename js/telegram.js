// Finantrix — integração com o Telegram (Bot API oficial e gratuita).
// As chamadas vão direto do navegador para api.telegram.org. O corpo é enviado como
// formulário (application/x-www-form-urlencoded) para não disparar a pré-verificação CORS,
// que a API do Telegram não aceita.
const API = 'https://api.telegram.org/bot';

export async function tg(token, method, params = {}, signal) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const r = await fetch(`${API}${token}/${method}`, { method: 'POST', body, signal });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) { const e = new Error(j.description || 'Erro no Telegram'); e.code = j.error_code; throw e; }
  return j.result;
}

export const tgEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function send(token, chatId, html, buttons) {
  return tg(token, 'sendMessage', {
    chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: buttons && buttons.length ? { inline_keyboard: buttons } : null
  });
}

// Long polling: fica escutando mensagens enquanto o Finantrix estiver aberto.
export function startPolling(token, onUpdate, { getOffset, setOffset }) {
  let stopped = false, ctrl = null;
  (async () => {
    let wait = 0;
    while (!stopped) {
      if (wait) { await new Promise(r => setTimeout(r, wait)); if (stopped) break; }
      try {
        ctrl = new AbortController();
        const offset = await getOffset();
        const ups = await tg(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, ctrl.signal);
        wait = 0;
        for (const u of ups) {
          await setOffset(u.update_id + 1);
          try { await onUpdate(u); } catch (e) { console.warn('Telegram update', e); }
        }
      } catch (e) {
        if (stopped || e.name === 'AbortError') break;
        // 409 = outra janela do Finantrix já está escutando; tenta de novo mais tarde
        wait = e.code === 409 ? 30000 : e.code === 401 ? 60000 : 8000;
      }
    }
  })();
  return () => { stopped = true; ctrl && ctrl.abort(); };
}

// Envia um arquivo (multipart sem cabeçalhos extras = requisição simples, sem pré-verificação CORS).
export async function sendDocument(token, chatId, blob, filename, caption) {
  const fd = new FormData();
  fd.append('chat_id', chatId);
  fd.append('document', blob, filename);
  if (caption) { fd.append('caption', caption); fd.append('parse_mode', 'HTML'); }
  fd.append('disable_notification', 'true');
  const r = await fetch(`${API}${token}/sendDocument`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) { const e = new Error(j.description || 'Erro ao enviar arquivo'); e.code = j.error_code; throw e; }
  return j.result;
}

// Baixa um arquivo enviado ao Telegram (ex.: o backup fixado na conversa).
export async function downloadFile(token, fileId) {
  const f = await tg(token, 'getFile', { file_id: fileId });
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
  if (!r.ok) throw new Error(`Não consegui baixar o backup (HTTP ${r.status})`);
  return r.text();
}
