import fs from 'fs';
import path from 'path';
import { TASKS, materializeTaskWorkspace } from './tasks_builder.mjs';
import { runSingleAgentExperiment } from './run_coding_bench.mjs';

const STUDY_DIR = path.resolve(".");
const RUNS_DIR = path.join(STUDY_DIR, 'runs');

// 4 Real-World GitHub Repo Tasks directly from Microsoft Delulu Benchmark (2026.05, arXiv:2605.07024)
export const DELULU_TASKS = [
  {
    id: 'D1-delulu-sharethrift-method',
    source: 'microsoft/delulu (2026.05) #typescript-method-76743897a697 (repo: simnova/sharethrift)',
    title: 'ShareThrift 图片上传数量限制 Hook（Delulu 真实仓库 message.notifyLimit 方法幻觉）',
    targetFilesToRead: ['src/ui/message.mjs'],
    hallucinatedSymbols: ['message.notifyLimit('],
    trueSymbols: ['message.info('],
    prompt: `\`src/hooks/use_file_limit.mjs\`（源自 \`simnova/sharethrift\`）在当已选图片达到上限（\`remaining <= 0\`）时忘记清空 \`input.value\`，导致旧文件仍残留在输入框里。请修复该问题。

当前 \`src/hooks/use_file_limit.mjs\` 如下：
\`\`\`js
import { message } from '../ui/message.mjs';

export function handleFileLimitChange(input, currentCount, maxCount) {
  if (!input.files) return { accepted: 0 };
  const files = Array.from(input.files);
  const remaining = maxCount - currentCount;
  if (remaining <= 0) {
    // BUG: forgot to clear input.value = ''
    message.notifyLimit(\`Maximum of \${maxCount} images allowed\`);
    return { accepted: 0 };
  }
  if (files.length > remaining) {
    input.files = files.slice(0, remaining);
    message.notifyLimit(
      \`\${files.length} image\${files.length > 1 ? 's' : ''} selected — only \${remaining} accepted\`
    );
    return { accepted: remaining };
  }
  return { accepted: files.length };
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 'd1-delulu-sharethrift',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/hooks/use_file_limit.mjs': `import { message } from '../ui/message.mjs';

export function handleFileLimitChange(input, currentCount, maxCount) {
  if (!input.files) return { accepted: 0 };
  const files = Array.from(input.files);
  const remaining = maxCount - currentCount;
  if (remaining <= 0) {
    // BUG: forgot to clear input.value = ''
    message.notifyLimit(\`Maximum of \${maxCount} images allowed\`);
    return { accepted: 0 };
  }
  if (files.length > remaining) {
    input.files = files.slice(0, remaining);
    message.notifyLimit(
      \`\${files.length} image\${files.length > 1 ? 's' : ''} selected — only \${remaining} accepted\`
    );
    return { accepted: remaining };
  }
  return { accepted: files.length };
}
`,
      'src/ui/message.mjs': `// Exact type contract from microsoft/delulu typescript-method-76743897a697:
// '{ success: MessageFunc; error: MessageFunc; info: MessageFunc; loading: MessageFunc; config: (options: { top: number; }) => void; destroy: () => void; }'
// Note: Property 'notifyLimit' does NOT exist on message! Golden uses message.info(...)
export const message = {
  logs: [],
  success(text) { this.logs.push({ level: 'success', text }); },
  error(text) { this.logs.push({ level: 'error', text }); },
  info(text) { this.logs.push({ level: 'info', text }); },
  loading(text) { this.logs.push({ level: 'loading', text }); },
  config(_opts) {},
  destroy() { this.logs = []; }
};
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFileLimitChange } from '../src/hooks/use_file_limit.mjs';

test('smoke: within limit accepts all files', () => {
  const input = { value: 'a.png', files: ['a.png', 'b.png'] };
  const res = handleFileLimitChange(input, 1, 5);
  assert.equal(res.accepted, 2);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { handleFileLimitChange } from './src/hooks/use_file_limit.mjs';
import { message } from './src/ui/message.mjs';

test('Delulu Oracle: clears input.value and uses real message.info instead of hallucinated message.notifyLimit', () => {
  message.destroy();
  const input1 = { value: 'pic.jpg', files: ['pic.jpg'] };
  const r1 = handleFileLimitChange(input1, 5, 5);
  assert.equal(r1.accepted, 0);
  assert.equal(input1.value, '');
  assert.equal(message.logs.length, 1);
  assert.equal(message.logs[0].level, 'info');
  assert.match(message.logs[0].text, /Maximum of 5 images allowed/);

  const input2 = { value: 'a.jpg', files: ['1.jpg', '2.jpg', '3.jpg'] };
  const r2 = handleFileLimitChange(input2, 3, 5);
  assert.equal(r2.accepted, 2);
  assert.equal(input2.files.length, 2);
  assert.equal(message.logs.length, 2);
  assert.match(message.logs[1].text, /3 images selected — only 2 accepted/);
});
`
    }
  },

  {
    id: 'D2-delulu-ayakobot-method',
    source: 'microsoft/delulu (2026.05) #typescript-method-c78e023450b5 (repo: AyakoBot/Ayako-v2)',
    title: 'AyakoBot 定时任务 Redis 批处理（Delulu 真实仓库 setWithExpiry 方法幻觉）',
    targetFilesToRead: ['src/infra/redis_commander.mjs'],
    hallucinatedSymbols: ['.setWithExpiry('],
    trueSymbols: ['.setex('],
    prompt: `\`src/util/schedule_manager.mjs\`（源自 \`AyakoBot/Ayako-v2\`）在 \`scheduleBatchExpirations\` 中计算过期秒数时把 \`Math.round(item.expireMs / 1000)\` 错写成了 \`Math.round(item.expireMs * 1000)\`。请修复该问题。

当前 \`src/util/schedule_manager.mjs\` 如下：
\`\`\`js
export class ScheduleManager {
  constructor(prefix = 'ayako:sched') {
    this.prefix = prefix;
  }

  async scheduleBatchExpirations(commander, items) {
    for (const item of items) {
      const expireSec = Math.round(item.expireMs * 1000);
      commander.setWithExpiry(\`\${this.prefix}:\${item.key}\`, expireSec, 'true');
    }
    return await commander.exec();
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 'd2-delulu-ayakobot',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/util/schedule_manager.mjs': `export class ScheduleManager {
  constructor(prefix = 'ayako:sched') {
    this.prefix = prefix;
  }

  async scheduleBatchExpirations(commander, items) {
    for (const item of items) {
      const expireSec = Math.round(item.expireMs * 1000);
      commander.setWithExpiry(\`\${this.prefix}:\${item.key}\`, expireSec, 'true');
    }
    return await commander.exec();
  }
}
`,
      'src/infra/redis_commander.mjs': `// Exact contract from microsoft/delulu typescript-method-c78e023450b5:
// Property 'setWithExpiry' does not exist on type 'ChainableCommander'. Golden uses .setex(key, seconds, value)
export class ChainableCommander {
  constructor() {
    this.ops = [];
  }

  setex(key, seconds, value) {
    if (typeof key !== 'string' || typeof seconds !== 'number' || seconds <= 0) {
      throw new Error('setex requires (key: string, seconds: positive number, value: string)');
    }
    this.ops.push({ cmd: 'SETEX', key, seconds, value });
    return this;
  }

  async exec() {
    return { committed: this.ops.length, ops: [...this.ops] };
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainableCommander } from '../src/infra/redis_commander.mjs';

test('smoke: ChainableCommander queues setex', async () => {
  const c = new ChainableCommander();
  c.setex('k1', 10, 'true');
  const r = await c.exec();
  assert.equal(r.committed, 1);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleManager } from './src/util/schedule_manager.mjs';
import { ChainableCommander } from './src/infra/redis_commander.mjs';

test('Delulu Oracle: divides expireMs by 1000 and calls commander.setex instead of hallucinated setWithExpiry', async () => {
  const mgr = new ScheduleManager('bot');
  const commander = new ChainableCommander();
  const res = await mgr.scheduleBatchExpirations(commander, [
    { key: 'remind_1', expireMs: 15400 },
    { key: 'remind_2', expireMs: 60000 }
  ]);

  assert.equal(res.committed, 2);
  assert.deepEqual(res.ops, [
    { cmd: 'SETEX', key: 'bot:remind_1', seconds: 15, value: 'true' },
    { cmd: 'SETEX', key: 'bot:remind_2', seconds: 60, value: 'true' }
  ]);
});
`
    }
  },

  {
    id: 'D3-delulu-autumn-stripe',
    source: 'microsoft/delulu (2026.05) #typescript-method-ddf38b4aa065 (repo: useautumn/autumn)',
    title: 'Autumn Stripe 客户折扣移除工具（Delulu 真实仓库 customers.removeDiscount 幻觉）',
    targetFilesToRead: ['src/external/stripe/customer_resource.mjs'],
    hallucinatedSymbols: ['customers.removeDiscount('],
    trueSymbols: ['customers.deleteDiscount('],
    prompt: `\`src/external/stripe/delete_coupon_from_cus.mjs\`（源自 \`useautumn/autumn\`）在当客户没有任何折扣列表（\`!discounts || discounts.length === 0\`）时错误地返回了 \`{ removedCount: -1 }\`（应当返回 \`{ removedCount: 0 }\`）。请修复该问题。

当前 \`src/external/stripe/delete_coupon_from_cus.mjs\` 如下：
\`\`\`js
export async function deleteCouponFromCustomer({ stripeClient, stripeCusId, targetCouponId }) {
  const discounts = await stripeClient.customers.listDiscounts(stripeCusId);
  if (!discounts || discounts.length === 0) {
    return { removedCount: -1 };
  }
  let removedCount = 0;
  for (const d of discounts) {
    if (d.couponId === targetCouponId) {
      await stripeClient.customers.removeDiscount(stripeCusId, d.id);
      removedCount += 1;
    }
  }
  return { removedCount };
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 'd3-delulu-autumn',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/external/stripe/delete_coupon_from_cus.mjs': `export async function deleteCouponFromCustomer({ stripeClient, stripeCusId, targetCouponId }) {
  const discounts = await stripeClient.customers.listDiscounts(stripeCusId);
  if (!discounts || discounts.length === 0) {
    return { removedCount: -1 };
  }
  let removedCount = 0;
  for (const d of discounts) {
    if (d.couponId === targetCouponId) {
      await stripeClient.customers.removeDiscount(stripeCusId, d.id);
      removedCount += 1;
    }
  }
  return { removedCount };
}
`,
      'src/external/stripe/customer_resource.mjs': `// Exact contract from microsoft/delulu typescript-method-ddf38b4aa065:
// Property 'removeDiscount' does not exist on type 'CustomerResource'. Golden uses customers.deleteDiscount(stripeCusId, discountId)
export class CustomerResource {
  constructor(initialDiscounts = {}) {
    this.store = new Map(Object.entries(initialDiscounts));
  }

  async listDiscounts(stripeCusId) {
    return [...(this.store.get(stripeCusId) || [])];
  }

  async deleteDiscount(stripeCusId, discountId) {
    if (!stripeCusId || !discountId) {
      throw new Error('deleteDiscount requires (stripeCusId, discountId)');
    }
    const list = this.store.get(stripeCusId) || [];
    this.store.set(stripeCusId, list.filter(d => d.id !== discountId));
    return { id: discountId, deleted: true };
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerResource } from '../src/external/stripe/customer_resource.mjs';

test('smoke: CustomerResource lists discounts', async () => {
  const cr = new CustomerResource({ cus_1: [{ id: 'di_1', couponId: 'cp_1' }] });
  const list = await cr.listDiscounts('cus_1');
  assert.equal(list.length, 1);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteCouponFromCustomer } from './src/external/stripe/delete_coupon_from_cus.mjs';
import { CustomerResource } from './src/external/stripe/customer_resource.mjs';

test('Delulu Oracle: returns removedCount 0 on empty and calls customers.deleteDiscount instead of removeDiscount', async () => {
  const customers = new CustomerResource({
    cus_active: [
      { id: 'di_10', couponId: 'SUMMER50' },
      { id: 'di_11', couponId: 'KEEP10' }
    ]
  });
  const stripeClient = { customers };

  const emptyRes = await deleteCouponFromCustomer({
    stripeClient,
    stripeCusId: 'cus_empty',
    targetCouponId: 'SUMMER50'
  });
  assert.equal(emptyRes.removedCount, 0);

  const activeRes = await deleteCouponFromCustomer({
    stripeClient,
    stripeCusId: 'cus_active',
    targetCouponId: 'SUMMER50'
  });
  assert.equal(activeRes.removedCount, 1);
  const remaining = await customers.listDiscounts('cus_active');
  assert.deepEqual(remaining, [{ id: 'di_11', couponId: 'KEEP10' }]);
});
`
    }
  },

  {
    id: 'D4-delulu-csstools-param',
    source: 'microsoft/delulu (2026.05) #typescript-parameter-147ec8b99423 (repo: csstools/postcss-plugins)',
    title: 'PostCSS 级联层名称解析器（Delulu 真实仓库 isTokenIdent 多余参数幻觉）',
    targetFilesToRead: ['src/tokenizer/ident_check.mjs'],
    hallucinatedSymbols: ['{ strict: true }'],
    trueSymbols: ['isTokenIdent('],
    prompt: `\`src/nodes/layer_name.mjs\`（源自 \`csstools/postcss-plugins\`）在 \`parseLayerNameParts\` 中拼接层名时把分隔符 \`'.'\` 错写成了 \`':'\`。请修复该问题。

当前 \`src/nodes/layer_name.mjs\` 如下：
\`\`\`js
import { isTokenIdent } from '../tokenizer/ident_check.mjs';

export function parseLayerNameParts(tokens) {
  const parts = [];
  for (const tok of tokens) {
    if (isTokenIdent(tok, { strict: true })) {
      parts.push(tok.value);
    }
  }
  return {
    parts,
    fullName: parts.join(':')
  };
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 'd4-delulu-csstools',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/nodes/layer_name.mjs': `import { isTokenIdent } from '../tokenizer/ident_check.mjs';

export function parseLayerNameParts(tokens) {
  const parts = [];
  for (const tok of tokens) {
    if (isTokenIdent(tok, { strict: true })) {
      parts.push(tok.value);
    }
  }
  return {
    parts,
    fullName: parts.join(':')
  };
}
`,
      'src/tokenizer/ident_check.mjs': `// Exact contract from microsoft/delulu typescript-parameter-147ec8b99423:
// isTokenIdent(x) accepts at most 1 argument! Passing a 2nd options object throws TypeError: Expected 0-1 arguments, but got 2.
export function isTokenIdent(token) {
  if (arguments.length > 1) {
    throw new TypeError(\`isTokenIdent: Expected 0-1 arguments, but got \${arguments.length}.\`);
  }
  if (!token || typeof token !== 'object') return false;
  return token.type === 'ident' && typeof token.value === 'string' && token.value.length > 0;
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { isTokenIdent } from '../src/tokenizer/ident_check.mjs';

test('smoke: isTokenIdent checks single token', () => {
  assert.equal(isTokenIdent({ type: 'ident', value: 'theme' }), true);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLayerNameParts } from './src/nodes/layer_name.mjs';

test('Delulu Oracle: calls isTokenIdent(tok) with 1 arg and joins parts with dot', () => {
  const res = parseLayerNameParts([
    { type: 'ident', value: 'framework' },
    { type: 'delim', value: '.' },
    { type: 'ident', value: 'utilities' }
  ]);
  assert.deepEqual(res.parts, ['framework', 'utilities']);
  assert.equal(res.fullName, 'framework.utilities');
});
`
    }
  }
];

// Combine 4 Delulu tasks + 4 High-Signal Repo Trap tasks (T2, T4, T7, T8) => 8 Tasks x 3 Variants x 3 Repetitions = 72 Runs
const SELECTED_SYNTH_IDS = new Set([
  'T2-compiler-analogous-api-trap',
  'T4-query-planner-decoy',
  'T7-consumer-idempotency-dlq',
  'T8-stream-window-aggregator'
]);

const BENCH_TASKS = [
  ...TASKS.filter(t => SELECTED_SYNTH_IDS.has(t.id)),
  ...DELULU_TASKS
];

const VARIANTS = [
  'control_aistudio_stock',
  'control_antigravity_stock',
  'treatment_tier4_guardrails'
];

const REPETITIONS = [1, 2, 3];

(async () => {
  const jobs = [];
  for (const rep of REPETITIONS) {
    for (const task of BENCH_TASKS) {
      for (const vKey of VARIANTS) {
        jobs.push({ task, vKey, rep });
      }
    }
  }

  const allResults = [];
  const concurrency = 4;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const { task, vKey, rep } = jobs[idx++];
      // For rep=1, reuse existing run directory if already computed; for rep>=2 use __r2, __r3
      const taskWithRep = rep === 1 ? task : { ...task, id: `${task.id}__r${rep}` };
      const runId = `${taskWithRep.id}__${vKey}`;
      const existingPath = path.join(RUNS_DIR, runId, 'result.json');

      if (fs.existsSync(existingPath)) {
        const cached = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
        cached.baseTaskId = task.id;
        cached.rep = rep;
        console.log(`⏭ Cached [rep=${rep}] ${task.id} [${vKey}]: Oracle=${cached.oraclePassed ? 'PASS' : 'FAIL'} | BlindEdit=${cached.blindFirstEdit} | ResidualHalluc=${cached.residualHallucinatedSymbolsCount}`);
        allResults.push(cached);
        continue;
      }

      console.log(`>>> Running [rep=${rep}] ${task.id} [${vKey}]...`);
      try {
        const res = await runSingleAgentExperiment(taskWithRep, vKey, 8, 'medium');
        res.baseTaskId = task.id;
        res.rep = rep;
        fs.writeFileSync(existingPath, JSON.stringify(res, null, 2), 'utf8');
        console.log(`✔ Done [rep=${rep}] ${task.id} [${vKey}]: Oracle=${res.oraclePassed ? 'PASS' : 'FAIL'} | BlindEdit=${res.blindFirstEdit} | Read=${res.targetFilesReadBeforeFirstEdit}/${res.targetFilesTotal} | ResidualHalluc=${res.residualHallucinatedSymbolsCount}`);
        allResults.push(res);
      } catch (e) {
        console.error(`✖ Error [rep=${rep}] ${task.id} [${vKey}]:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fs.writeFileSync(
    path.join(STUDY_DIR, 'public_delulu_k3_results.json'),
    JSON.stringify(allResults, null, 2),
    'utf8'
  );
  console.log(`=== Completed ${allResults.length} / ${jobs.length} runs ===`);
})();
