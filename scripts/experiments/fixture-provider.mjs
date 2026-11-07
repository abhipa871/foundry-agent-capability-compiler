#!/usr/bin/env node
// Labeled fixture provider for harness validation only: no network, no model, no inference.
// It speaks the subset of the Codex app-server protocol the experiment agent uses. A scripted
// stand-in agent calls the offered read tools for the reads named in FOUNDRY_FIXTURE_POLICY,
// retries a failed read within the stated budget, and derives every answer only from reads it
// actually received. Token usage is synthetic and deterministic; it is never a measurement.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const lookups = {
  lookup_customer: 'crm.getCustomer',
  lookup_orders: 'orders.list',
  lookup_refund_history: 'payments.refundHistory',
};
const keys = {
  'crm.getCustomer': 'crm_get_customer',
  'orders.list': 'orders_list',
  'payments.refundHistory': 'payments_refund_history',
};
const all = Object.values(lookups);
const suppliedMarker =
  'Authorized reads already completed (use only fields needed for the message):';
const statusMarker = 'Observed read status:';
const threads = new Map();
const pending = new Map();
let nextId = 1000;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lineAfter = (text, marker) => {
  const lines = text.split('\n');
  const index = lines.indexOf(marker);
  return index >= 0 ? JSON.parse(lines[index + 1]) : undefined;
};

function usage(thread, inputTokens, outputTokens) {
  thread.total.inputTokens += inputTokens;
  thread.total.outputTokens += outputTokens;
  thread.total.totalTokens += inputTokens + outputTokens;
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: thread.id,
      tokenUsage: {
        total: { ...thread.total },
        last: {
          inputTokens,
          outputTokens,
          cachedInputTokens: 0,
          totalTokens: inputTokens + outputTokens,
        },
      },
    },
  });
}
function call(thread, tool) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ id, method: 'item/tool/call', params: { threadId: thread.id, tool, arguments: {} } });
  });
}
function mostDelayed(orders) {
  return [...orders].sort((a, b) => b.daysLate - a.daysLate || a.id.localeCompare(b.id))[0];
}
function answer(customerId, needed, obtained) {
  const missing = needed.some((operation) => obtained[operation] === undefined);
  const empty = {
    customerId,
    eligible: null,
    orders: null,
    refunds: null,
    selectedOrderId: null,
  };
  if (missing)
    return {
      ...empty,
      action: 'unavailable',
      reply:
        'I am sorry, but a required account service is unavailable right now, so I cannot confirm these records yet. Nothing on your account has been changed; please try again shortly.',
    };
  if (!needed.length)
    return {
      ...empty,
      action: 'policy_info',
      reply:
        'Delayed deliveries are reviewed by our support team. Depending on eligibility and delay, we may arrange delivery support or a review by a specialist. No account records were accessed for this general answer.',
    };
  const has = (operation) => needed.includes(operation);
  const customer = obtained['crm.getCustomer'];
  const orders = has('orders.list')
    ? obtained['orders.list'].orders.map(({ id, daysLate }) => ({ id, daysLate }))
    : null;
  const refunds = has('payments.refundHistory')
    ? obtained['payments.refundHistory'].refunds.map(({ id, amount }) => ({ id, amount }))
    : null;
  const selected = orders?.length ? mostDelayed(orders) : undefined;
  const action =
    needed.length === 3
      ? !customer.eligible
        ? 'delivery_support'
        : refunds.length
          ? 'human_review'
          : selected && selected.daysLate >= 7
            ? 'refund_review'
            : 'delivery_support'
      : needed.length === 2
        ? 'records_summary'
        : has('crm.getCustomer')
          ? 'eligibility_info'
          : has('orders.list')
            ? 'order_status'
            : 'refund_status';
  const parts = [
    has('crm.getCustomer')
      ? `Your account is ${customer.eligible ? '' : 'not '}eligible for delay support.`
      : '',
    selected ? `Order ${selected.id} is your most delayed order at ${selected.daysLate} days.` : '',
    refunds ? `We found ${refunds.length} recorded refund(s) on your account.` : '',
  ];
  return {
    customerId,
    eligible: has('crm.getCustomer') ? customer.eligible : null,
    orders,
    refunds,
    selectedOrderId: selected?.id ?? null,
    action,
    reply: `Thank you for contacting us. ${parts.filter(Boolean).join(' ')} A support operator will follow up on next steps; nothing has been changed on your account.`,
  };
}

async function run(thread, prompt) {
  const context = thread.instructions.startsWith('You retrieve customer context');
  const customerId = /\b(C-\d{3})\b/.exec(prompt)?.[1];
  const policy = context
    ? { neededReads: all }
    : JSON.parse(readFileSync(process.env.FOUNDRY_FIXTURE_POLICY, 'utf8'));
  const needed = policy.neededReads;
  const obtained = { ...(lineAfter(prompt, suppliedMarker) ?? {}) };
  const status = lineAfter(prompt, statusMarker) ?? {};
  const remaining = Object.fromEntries(
    all.map((operation) => [operation, status[operation]?.retriesRemaining ?? 2]),
  );
  let observed = prompt.length;
  let loaderTried = false;
  for (let round = 0; round < 4; round++) {
    const missing = needed.filter((op) => obtained[op] === undefined && remaining[op] > 0);
    if (!missing.length) break;
    const useLoader =
      !loaderTried &&
      thread.tools.includes('load_customer_context') &&
      needed.length === 3 &&
      missing.length === 3;
    const calls = useLoader
      ? ['load_customer_context']
      : Object.entries(lookups)
          .filter(([name, op]) => thread.tools.includes(name) && missing.includes(op))
          .map(([name]) => name);
    if (!calls.length) break;
    usage(thread, 400 + Math.ceil(observed / 4), 20);
    const results = await Promise.all(calls.map((name) => call(thread, name)));
    results.forEach((result, index) => {
      const name = calls[index];
      const text = result?.contentItems?.[0]?.text ?? '';
      observed += text.length;
      if (name === 'load_customer_context') {
        loaderTried = true;
        if (!result.success) return;
        const value = JSON.parse(text);
        if (value.customer_id) for (const op of all) obtained[op] = value[keys[op]];
        else {
          Object.assign(obtained, value.availableReads ?? {});
          for (const [op, entry] of Object.entries(value.serviceStatus ?? {}))
            remaining[op] = entry.retriesRemaining;
        }
        return;
      }
      const op = lookups[name];
      if (result.success) obtained[op] = JSON.parse(text);
      else remaining[op] -= 1;
    });
  }
  usage(thread, 400 + Math.ceil(observed / 4), 120);
  const final = context
    ? {
        context: all.every((op) => obtained[op] !== undefined)
          ? {
              customer_id: customerId,
              ...Object.fromEntries(all.map((op) => [keys[op], obtained[op]])),
            }
          : null,
      }
    : answer(customerId, needed, obtained);
  send({
    method: 'item/completed',
    params: { threadId: thread.id, item: { type: 'agentMessage', text: JSON.stringify(final) } },
  });
  send({
    method: 'turn/completed',
    params: { threadId: thread.id, turn: { status: 'completed' } },
  });
}

if (process.argv.includes('--version')) {
  process.stdout.write('foundry-fixture-provider 1 (no inference)\n');
  process.exit(0);
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id !== undefined && !message.method) {
    pending.get(Number(message.id))?.(message.result);
    pending.delete(Number(message.id));
    return;
  }
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  else if (message.method === 'thread/start') {
    const id = `fixture-thread-${nextId++}`;
    threads.set(id, {
      id,
      tools: (message.params.dynamicTools ?? []).map((tool) => tool.name),
      instructions: message.params.baseInstructions ?? '',
      total: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
    });
    send({ id: message.id, result: { thread: { id }, model: message.params.model } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: `fixture-turn-${nextId++}` } } });
    const thread = threads.get(message.params.threadId);
    void run(thread, message.params.input[0].text).catch(() =>
      send({
        method: 'turn/completed',
        params: { threadId: thread.id, turn: { status: 'failed' } },
      }),
    );
  } else if (['turn/interrupt', 'thread/archive'].includes(message.method))
    send({ id: message.id, result: {} });
});
lines.on('close', () => process.exit(0));
