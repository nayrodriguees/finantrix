// Finantrix — IA Premium (Claude). Opcional: só é usada se você salvar sua chave da API em Configurações.
// Sem chave (ou se a chamada falhar), o interpretador local (parser.js) assume.
import { CATEGORIES, iso, today, WEEKDAYS, normalizeKind } from './core.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.133.0/+esm';
const MODEL = 'claude-opus-5-5';
let clientP = null, clientKey = null;

async function getClient(apiKey) {
  if (clientP && clientKey === apiKey) return clientP;
  clientKey = apiKey;
  clientP = import(SDK_URL).then(mod => {
    const Anthropic = mod.default || mod.Anthropic;
    return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  });
  return clientP;
}

const nullable = t => ({ anyOf: [{ type: t }, { type: 'null' }] });
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'items', 'target_title', 'amount', 'query', 'reply'],
  properties: {
    intent: { type: 'string', enum: ['create', 'pay', 'complete', 'query'] },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'title', 'category', 'date', 'time', 'recurrence', 'amount', 'notes'],
        properties: {
          kind: { type: 'string', enum: ['task', 'event', 'bill'] },
          title: { type: 'string' },
          category: { type: 'string', enum: Object.keys(CATEGORIES) },
          date: nullable('string'),
          time: nullable('string'),
          recurrence: {
            type: 'object', additionalProperties: false,
            required: ['type', 'day', 'weekday', 'month'],
            properties: {
              type: { type: 'string', enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'] },
              day: nullable('integer'), weekday: nullable('integer'), month: nullable('integer')
            }
          },
          amount: nullable('number'),
          notes: { type: 'string' }
        }
      }
    },
    target_title: nullable('string'),
    amount: nullable('number'),
    query: {
      type: 'object', additionalProperties: false, required: ['scope', 'topic', 'date'],
      properties: {
        scope: { type: 'string', enum: ['today', 'tomorrow', 'week', 'month', 'date'] },
        topic: { type: 'string', enum: ['all', 'bills', 'events'] },
        date: nullable('string')
      }
    },
    reply: { type: 'string' }
  }
};

function systemPrompt(items) {
  const t = today();
  const known = items.slice(0, 80).map(i => `- ${i.title} (${i.kind}${i.recurrence ? ', recorrente' : ''})`).join('\n') || '(nenhum)';
  return `Você é a secretária virtual do Finantrix, um painel pessoal de agenda e contas. Interprete o que a pessoa disse (transcrição de áudio em português do Brasil, pode ter erros de reconhecimento) e devolva o JSON pedido.

Hoje é ${WEEKDAYS[t.getDay()]}, ${iso(t)}. Datas sempre em AAAA-MM-DD, horários em HH:MM (24h).

Intenções:
- create: anotar itens. Uma fala pode ter vários itens. Classificação OBRIGATÓRIA (não misturar):
  * kind "event" (Compromissos): consultas e tudo que exige sair de casa. Categorias: saude (médico, dentista, exames, academia), externo (banco, cartório, buscar/levar alguém, oficina, salão, ir a algum lugar), compras (mercado, farmácia, lojas), social (aniversário, festa, jantar, viagem).
  * kind "task" (Tarefas): trabalho e afazeres feitos sem sair de casa. Categorias: trabalho (reuniões, projetos, clientes, e-mails, entregas), casa (limpar, lavar, organizar), pessoal, tarefa.
  * kind "bill" (Contas): contas e boletos a pagar, com as categorias de conta (energia, agua, internet, telefone, gas, moradia, cartao, impostos, assinatura, educacao, saudeplano, transporte, financeiro, outros).
  A categoria precisa ser do mesmo grupo do kind.
- pay: a pessoa diz que já pagou uma conta. Coloque em target_title o nome da conta existente mais parecida e em amount o valor, se dito.
- complete: a pessoa diz que concluiu uma tarefa/compromisso. Use target_title.
- query: a pessoa pergunta sobre a agenda ou contas ("o que tenho amanhã?", "quanto falta pagar esse mês?").

Regras:
- Títulos curtos e limpos, com acentuação correta ("Médico", "Energia", "Reunião com cliente"). Não inclua data, hora ou valor no título.
- Recorrência: "todo dia 15" = monthly com day 15; "toda segunda" = weekly com weekday 1 (0=domingo); "todo ano" = yearly com day e month (0=janeiro); sem recorrência use type "none" e campos null.
- Para contas recorrentes, date é o próximo vencimento. Para "dia 10" sem mês, use o próximo dia 10 a partir de hoje.
- Se não houver data para tarefa ou compromisso, use hoje. "de manhã" = 09:00, "à tarde" = 14:00, "à noite" = 19:00.
- amount em reais como número (ex.: 1500.5). null quando não dito.
- reply: uma frase curta e simpática confirmando o que entendeu, como uma secretária falaria.
- Campos que não se aplicam: items [] , target_title null, amount null, query {scope:"week", topic:"all", date:null}.

Itens já cadastrados (para pay/complete):
${known}`;
}

export async function aiInterpret(text, items, apiKey) {
  const client = await getClient(apiKey);
  const resp = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: systemPrompt(items),
    messages: [{ role: 'user', content: text }]
  });
  if (resp.stop_reason === 'refusal') throw new Error('A IA recusou a solicitação');
  const block = resp.content.find(b => b.type === 'text');
  if (!block) throw new Error('Resposta vazia da IA');
  const out = JSON.parse(block.text);

  const fixRec = r => (!r || r.type === 'none') ? null
    : r.type === 'monthly' ? { type: 'monthly', day: r.day || today().getDate() }
    : r.type === 'weekly' ? { type: 'weekly', weekday: r.weekday ?? today().getDay() }
    : r.type === 'yearly' ? { type: 'yearly', day: r.day || 1, month: r.month ?? 0 }
    : { type: 'daily' };

  const findByTitle = title => {
    if (!title) return null;
    const n = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return items.find(i => n(i.title) === n(title)) || items.find(i => n(i.title).includes(n(title)) || n(title).includes(n(i.title))) || null;
  };

  return {
    intent: out.intent,
    reply: out.reply,
    text,
    ai: true,
    amount: out.amount,
    target: findByTitle(out.target_title),
    query: { ...out.query, overdue: /vencid|atrasad/i.test(text) },
    items: out.items.map(i => normalizeKind({
      kind: i.kind, title: i.title, category: i.category, date: i.date, time: i.time,
      recurrence: fixRec(i.recurrence), amount: i.kind === 'bill' ? i.amount : null,
      notes: i.notes || '', source: text, missing: i.kind === 'bill' && !i.date ? ['date'] : []
    }))
  };
}
