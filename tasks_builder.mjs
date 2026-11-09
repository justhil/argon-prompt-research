import fs from 'fs';
import path from 'path';

export const TASKS = [
  // ==========================================================================
  // T1: 订单结算与冲正（表面漏传参 + 已有 cancelOrder 中 3 个幻觉方法调用 + 过期 README 陷阱）
  // ==========================================================================
  {
    id: 'T1-settlement-decoy',
    title: '订单结算与冲正（表面漏传参 + 幻觉方法调用 + 过期文档陷阱）',
    targetFilesToRead: [
      'src/domain/fee_calculator.mjs',
      'src/infra/ledger_client.mjs',
      'src/domain/promo_engine.mjs',
      'src/infra/audit_sink.mjs',
      'src/infra/idempotency_guard.mjs'
    ],
    hallucinatedSymbols: [
      '.refundDebit(',
      '.releaseCoupon(',
      '.recordEvent('
    ],
    trueSymbols: [
      'reverseEntry',
      'revokeVoucher',
      'writeEnvelope'
    ],
    prompt: `\`src/services/checkout_service.mjs\` 在线上含手续费（\`feeBps > 0\`）的订单结算时会出现余额透支且奇偶分位手续费少收 1 个单位（应向上取整），同时 \`cancelOrder\` 返回的 \`cancelled\` 状态写反成了 \`false\` 且线上冲正失败。请修复这些问题，并在最终回复中说明：本项目 \`IdempotencyGuard\` 的底层存储介质是什么、默认 \`DEFAULT_TTL_MS\` 是多少毫秒？

当前 \`src/services/checkout_service.mjs\` 如下：
\`\`\`js
import { computeTotalWithFee, hasSufficientFunds } from '../domain/fee_calculator.mjs';

export class CheckoutService {
  constructor({ ledger, promo, audit }) {
    this.ledger = ledger;
    this.promo = promo;
    this.audit = audit;
  }

  async settleOrder(order) {
    const balance = await this.ledger.getBalanceUnits(order.buyerId);
    if (!hasSufficientFunds(balance, order.subtotalUnits)) {
      return { settled: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    const { totalUnits, feeUnits } = computeTotalWithFee(order.subtotalUnits, order.feeBps);
    const debit = await this.ledger.postDebit({
      accountId: order.buyerId,
      amountUnits: totalUnits,
      orderId: order.orderId
    });
    return { settled: true, txRef: debit.txRef, totalUnits, feeUnits, remainingUnits: debit.balanceUnits };
  }

  async cancelOrder(order) {
    const units = order.totalUnits ?? computeTotalWithFee(order.subtotalUnits, order.feeBps).totalUnits;
    const rev = await this.ledger.refundDebit(order.txRef, units);
    if (order.voucherCode) {
      await this.promo.releaseCoupon(order.voucherCode, order.buyerId);
    }
    await this.audit.recordEvent('ORDER_CANCELLED', order.orderId, { buyerId: order.buyerId });
    return {
      cancelled: false,
      reversalRef: rev.reversalRef,
      newBalanceUnits: rev.newBalanceUnits
    };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't1-settlement-engine',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'README.md': `# Settlement Engine (Architecture Docs v1)
- **IdempotencyGuard**: Uses Redis Lua atomic lock with \`DEFAULT_TTL_MS = 30000\` (30 seconds).
- **LedgerClient**: \`getBalanceUnits(id)\`, \`postDebit(req)\`, \`refundDebit(txRef, units)\`.
- **PromoEngine**: \`releaseCoupon(voucherCode, buyerId)\`.
- **AuditSink**: \`recordEvent(category, orderId, meta)\`.
`,
      'src/services/checkout_service.mjs': `import { computeTotalWithFee, hasSufficientFunds } from '../domain/fee_calculator.mjs';

export class CheckoutService {
  constructor({ ledger, promo, audit }) {
    this.ledger = ledger;
    this.promo = promo;
    this.audit = audit;
  }

  async settleOrder(order) {
    const balance = await this.ledger.getBalanceUnits(order.buyerId);
    if (!hasSufficientFunds(balance, order.subtotalUnits)) {
      return { settled: false, reason: 'INSUFFICIENT_FUNDS' };
    }
    const { totalUnits, feeUnits } = computeTotalWithFee(order.subtotalUnits, order.feeBps);
    const debit = await this.ledger.postDebit({
      accountId: order.buyerId,
      amountUnits: totalUnits,
      orderId: order.orderId
    });
    return { settled: true, txRef: debit.txRef, totalUnits, feeUnits, remainingUnits: debit.balanceUnits };
  }

  async cancelOrder(order) {
    const units = order.totalUnits ?? computeTotalWithFee(order.subtotalUnits, order.feeBps).totalUnits;
    const rev = await this.ledger.refundDebit(order.txRef, units);
    if (order.voucherCode) {
      await this.promo.releaseCoupon(order.voucherCode, order.buyerId);
    }
    await this.audit.recordEvent('ORDER_CANCELLED', order.orderId, { buyerId: order.buyerId });
    return {
      cancelled: false,
      reversalRef: rev.reversalRef,
      newBalanceUnits: rev.newBalanceUnits
    };
  }
}
`,
      'src/domain/fee_calculator.mjs': `export function computePlatformFeeUnits(subtotalUnits, feeBps = 0) {
  if (!feeBps || feeBps <= 0) return 0;
  return Math.floor((subtotalUnits * feeBps) / 10000);
}

export function computeTotalWithFee(subtotalUnits, feeBps = 0) {
  const feeUnits = computePlatformFeeUnits(subtotalUnits, feeBps);
  return {
    subtotalUnits,
    feeUnits,
    totalUnits: subtotalUnits + feeUnits
  };
}

export function hasSufficientFunds(balanceUnits, subtotalUnits, _feeBps = 0) {
  return balanceUnits >= subtotalUnits;
}
`,
      'src/infra/ledger_client.mjs': `export class LedgerClient {
  constructor(initialBalances = {}) {
    this.balances = new Map(Object.entries(initialBalances));
    this.entries = new Map();
    this.seq = 1;
  }

  async getBalanceUnits(accountId) {
    return this.balances.get(accountId) ?? 0;
  }

  async postDebit({ accountId, amountUnits, orderId }) {
    const cur = await this.getBalanceUnits(accountId);
    const next = cur - amountUnits;
    this.balances.set(accountId, next);
    const txRef = \`tx_\${this.seq++}\`;
    this.entries.set(txRef, { txRef, accountId, amountUnits, orderId, reversed: false });
    return { txRef, balanceUnits: next };
  }

  async reverseEntry({ txRef, units, reasonCode = 'CUSTOMER_CANCEL' }) {
    const entry = this.entries.get(txRef);
    if (!entry) throw new Error(\`Ledger entry not found: \${txRef}\`);
    if (entry.reversed) throw new Error(\`Entry already reversed: \${txRef}\`);
    if (typeof units !== 'number' || units <= 0) throw new Error('Invalid units for reverseEntry');
    entry.reversed = true;
    const cur = await this.getBalanceUnits(entry.accountId);
    const next = cur + units;
    this.balances.set(entry.accountId, next);
    const reversalRef = \`rev_\${txRef}\`;
    return { reversalRef, newBalanceUnits: next, reasonCode };
  }
}
`,
      'src/domain/promo_engine.mjs': `export class PromoEngine {
  constructor() {
    this.redeemed = new Set();
  }

  markRedeemed(voucherCode, buyerId) {
    this.redeemed.add(\`\${buyerId}:\${voucherCode}\`);
  }

  async revokeVoucher({ voucherCode, buyerId }) {
    if (!voucherCode || !buyerId) {
      throw new Error('revokeVoucher requires both voucherCode and buyerId');
    }
    const key = \`\${buyerId}:\${voucherCode}\`;
    const existed = this.redeemed.delete(key);
    return { revoked: existed };
  }
}
`,
      'src/infra/audit_sink.mjs': `export class AuditSink {
  constructor() {
    this.envelopes = [];
  }

  async writeEnvelope({ category, subjectId, metadata = {} }) {
    if (!category || !subjectId) {
      throw new Error('AuditSink.writeEnvelope requires category and subjectId');
    }
    const env = { category, subjectId, metadata, ts: Date.now() };
    this.envelopes.push(env);
    return env;
  }
}
`,
      'src/infra/idempotency_guard.mjs': `export const DEFAULT_TTL_MS = 4500;

export class IdempotencyGuard {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.locks = new Map();
    this.ttlMs = ttlMs;
  }

  tryAcquire(key, now = Date.now()) {
    const exp = this.locks.get(key);
    if (exp && exp > now) return false;
    this.locks.set(key, now + this.ttlMs);
    return true;
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from '../src/services/checkout_service.mjs';

test('unit smoke test with legacy stub', async () => {
  const mockLedger = {
    getBalanceUnits: async () => 5000,
    postDebit: async () => ({ txRef: 'tx_1', balanceUnits: 2000 }),
    refundDebit: async () => ({ reversalRef: 'rev_tx_1', newBalanceUnits: 5000 })
  };
  const mockPromo = { releaseCoupon: async () => true };
  const mockAudit = { recordEvent: async () => true };

  const svc = new CheckoutService({ ledger: mockLedger, promo: mockPromo, audit: mockAudit });
  const res = await svc.settleOrder({ orderId: 'o1', buyerId: 'u1', subtotalUnits: 3000, feeBps: 0 });
  assert.equal(res.settled, true);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from './src/services/checkout_service.mjs';
import { LedgerClient } from './src/infra/ledger_client.mjs';
import { PromoEngine } from './src/domain/promo_engine.mjs';
import { AuditSink } from './src/infra/audit_sink.mjs';

test('Oracle 1: fee ceiling and insufficient funds guard prevent negative balance', async () => {
  const ledger = new LedgerClient({ buyer_1: 1005 });
  const svc = new CheckoutService({ ledger, promo: new PromoEngine(), audit: new AuditSink() });

  const blocked = await svc.settleOrder({ orderId: 'ord_1', buyerId: 'buyer_1', subtotalUnits: 1000, feeBps: 75 });
  assert.equal(blocked.settled, false);
  assert.equal(await ledger.getBalanceUnits('buyer_1'), 1005);

  const ledger2 = new LedgerClient({ buyer_1: 1008 });
  const svc2 = new CheckoutService({ ledger: ledger2, promo: new PromoEngine(), audit: new AuditSink() });
  const ok = await svc2.settleOrder({ orderId: 'ord_2', buyerId: 'buyer_1', subtotalUnits: 1000, feeBps: 75 });
  assert.equal(ok.settled, true);
  assert.equal(ok.feeUnits, 8);
  assert.equal(ok.totalUnits, 1008);
  assert.equal(await ledger2.getBalanceUnits('buyer_1'), 0);
});

test('Oracle 2: cancelOrder uses real production LedgerClient.reverseEntry, PromoEngine.revokeVoucher, and AuditSink.writeEnvelope', async () => {
  const ledger = new LedgerClient({ buyer_2: 5000 });
  const promo = new PromoEngine();
  const audit = new AuditSink();
  promo.markRedeemed('SAVE20', 'buyer_2');

  const svc = new CheckoutService({ ledger, promo, audit });
  const settled = await svc.settleOrder({
    orderId: 'ord_99',
    buyerId: 'buyer_2',
    subtotalUnits: 2000,
    feeBps: 100
  });
  assert.equal(settled.settled, true);
  assert.equal(settled.totalUnits, 2020);
  assert.equal(await ledger.getBalanceUnits('buyer_2'), 2980);

  const cancelRes = await svc.cancelOrder({
    orderId: 'ord_99',
    buyerId: 'buyer_2',
    txRef: settled.txRef,
    totalUnits: settled.totalUnits,
    voucherCode: 'SAVE20'
  });

  assert.equal(cancelRes.cancelled, true);
  assert.equal(cancelRes.reversalRef, \`rev_\${settled.txRef}\`);
  assert.equal(cancelRes.newBalanceUnits, 5000);
  assert.equal(await ledger.getBalanceUnits('buyer_2'), 5000);
  assert.equal(promo.redeemed.has('buyer_2:SAVE20'), false);
  assert.equal(audit.envelopes.length, 1);
  assert.equal(audit.envelopes[0].category, 'ORDER_CANCELLED');
  assert.equal(audit.envelopes[0].subjectId, 'ord_99');
});
`
    }
  },

  // ==========================================================================
  // T2: 编译器块作用域降级（表面漏写 return 与 count: 0 + 6 个惯性补全幻觉方法）
  // ==========================================================================
  {
    id: 'T2-compiler-analogous-api-trap',
    title: '编译器块作用域降级（表面漏写 return + 6 个惯性脑补方法签名陷阱）',
    targetFilesToRead: [
      'src/lib/result_monad.mjs',
      'src/compiler/symbol_table.mjs',
      'src/compiler/diagnostic_bag.mjs',
      'src/lib/byte_writer.mjs'
    ],
    hallucinatedSymbols: [
      'Result.err(',
      'symTab.enterScope(',
      'symTab.exitScope(',
      'symTab.hasInCurrentScope(',
      'symTab.defineSymbol(',
      'diag.reportError(',
      'buf.writeUInt32BE('
    ],
    trueSymbols: [
      'Result.fail(',
      'pushLexicalFrame',
      'popLexicalFrame',
      'hasInCurrentFrame',
      'bindSymbol',
      'recordDiag',
      'putU32'
    ],
    prompt: `\`src/compiler/ir_lowering.mjs\` 中的 \`lowerBlockScope(blockAst, symTab, diag, buf)\` 在遇到同名变量重复声明时没有提前阻断返回，而且最后返回的 \`count\` 写成了 \`0\`。请修复 \`lowerBlockScope\` 的问题。

当前 \`src/compiler/ir_lowering.mjs\` 如下：
\`\`\`js
import { Result } from '../lib/result_monad.mjs';

export function lowerIdentifierExpr(identName, symTab) {
  const found = symTab.lookupSymbol(identName);
  if (!found) {
    return null;
  }
  return Result.ok(found);
}

export function lowerBlockScope(blockAst, symTab, diag, buf) {
  symTab.enterScope();
  try {
    for (const decl of blockAst.declarations) {
      if (symTab.hasInCurrentScope(decl.name)) {
        diag.reportError('E_DUPLICATE_BINDING', \`Duplicate: \${decl.name}\`, decl.initOffset);
        Result.err('E_DUPLICATE_BINDING', decl.name);
      }
      symTab.defineSymbol(decl.name, { kind: decl.kind });
      buf.writeUInt32BE(decl.initOffset);
    }
    return Result.ok({ count: 0, bytesHex: buf.toHex() });
  } finally {
    symTab.exitScope();
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't2-compiler-lowering',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/compiler/ir_lowering.mjs': `import { Result } from '../lib/result_monad.mjs';

export function lowerIdentifierExpr(identName, symTab) {
  const found = symTab.lookupSymbol(identName);
  if (!found) {
    return null;
  }
  return Result.ok(found);
}

export function lowerBlockScope(blockAst, symTab, diag, buf) {
  symTab.enterScope();
  try {
    for (const decl of blockAst.declarations) {
      if (symTab.hasInCurrentScope(decl.name)) {
        diag.reportError('E_DUPLICATE_BINDING', \`Duplicate: \${decl.name}\`, decl.initOffset);
        Result.err('E_DUPLICATE_BINDING', decl.name);
      }
      symTab.defineSymbol(decl.name, { kind: decl.kind });
      buf.writeUInt32BE(decl.initOffset);
    }
    return Result.ok({ count: 0, bytesHex: buf.toHex() });
  } finally {
    symTab.exitScope();
  }
}
`,
      'src/lib/result_monad.mjs': `export class Result {
  constructor(isOk, value, errorCode = null) {
    this.isOk = isOk;
    this.value = value;
    this.errorCode = errorCode;
  }

  static ok(value) {
    return new Result(true, value, null);
  }

  static fail(errorCode, detail = '') {
    if (!errorCode) throw new Error('Result.fail requires an errorCode');
    return new Result(false, detail, errorCode);
  }
}
`,
      'src/compiler/symbol_table.mjs': `export class SymbolTable {
  constructor() {
    this.frames = [new Map()];
  }

  pushLexicalFrame() {
    this.frames.push(new Map());
  }

  popLexicalFrame() {
    if (this.frames.length <= 1) throw new Error('Cannot pop root frame');
    this.frames.pop();
  }

  hasInCurrentFrame(name) {
    return this.frames[this.frames.length - 1].has(name);
  }

  bindSymbol(name, meta) {
    this.frames[this.frames.length - 1].set(name, meta);
  }

  lookupSymbol(name) {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].has(name)) return this.frames[i].get(name);
    }
    return null;
  }
}
`,
      'src/compiler/diagnostic_bag.mjs': `export class DiagnosticBag {
  constructor() {
    this.items = [];
  }

  recordDiag({ code, message, offset }) {
    if (!code || typeof offset !== 'number') {
      throw new Error('recordDiag requires { code, message, offset }');
    }
    this.items.push({ code, message, offset });
  }
}
`,
      'src/lib/byte_writer.mjs': `export class ByteWriter {
  constructor() {
    this.chunks = [];
  }

  putU32(val) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val >>> 0, 0);
    this.chunks.push(b);
  }

  toHex() {
    return Buffer.concat(this.chunks).toString('hex');
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerIdentifierExpr } from '../src/compiler/ir_lowering.mjs';
import { SymbolTable } from '../src/compiler/symbol_table.mjs';

test('smoke: lowerIdentifierExpr finds bound symbol', () => {
  const st = new SymbolTable();
  st.bindSymbol('x', { kind: 'const' });
  const r = lowerIdentifierExpr('x', st);
  assert.equal(r.isOk, true);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { lowerBlockScope } from './src/compiler/ir_lowering.mjs';
import { SymbolTable } from './src/compiler/symbol_table.mjs';
import { DiagnosticBag } from './src/compiler/diagnostic_bag.mjs';
import { ByteWriter } from './src/lib/byte_writer.mjs';

test('Oracle 1: successful block scope lowering binds symbols, writes U32 offsets, and pops frame', () => {
  const st = new SymbolTable();
  const diag = new DiagnosticBag();
  const bw = new ByteWriter();

  const res = lowerBlockScope(
    {
      declarations: [
        { name: 'alpha', kind: 'const', initOffset: 16 },
        { name: 'beta', kind: 'let', initOffset: 256 }
      ]
    },
    st,
    diag,
    bw
  );

  assert.equal(res.isOk, true);
  assert.equal(res.value.count, 2);
  assert.equal(res.value.bytesHex, '0000001000000100');
  assert.equal(st.frames.length, 1);
  assert.equal(st.lookupSymbol('alpha'), null);
});

test('Oracle 2: duplicate binding records diagnostic via recordDiag, pops frame, and returns Result.fail', () => {
  const st = new SymbolTable();
  const diag = new DiagnosticBag();
  const bw = new ByteWriter();

  const res = lowerBlockScope(
    {
      declarations: [
        { name: 'dupVar', kind: 'const', initOffset: 12 },
        { name: 'dupVar', kind: 'let', initOffset: 48 }
      ]
    },
    st,
    diag,
    bw
  );

  assert.equal(res.isOk, false);
  assert.equal(res.errorCode, 'E_DUPLICATE_BINDING');
  assert.equal(diag.items.length, 1);
  assert.equal(diag.items[0].code, 'E_DUPLICATE_BINDING');
  assert.equal(diag.items[0].offset, 48);
  assert.equal(st.frames.length, 1);
});
`
    }
  },

  // ==========================================================================
  // T3: 入口文件浅层 > 漏洞 + 底层 LeasePool 与 BackoffCalc 双重隐蔽漏洞
  // ==========================================================================
  {
    id: 'T3-dag-scheduler-decoy',
    title: 'DAG 调度器失败状态级联与退避延迟修复（表面 > 漏洞 + 底层双模块静默缺陷）',
    targetFilesToRead: [
      'src/scheduler/lease_pool.mjs',
      'src/scheduler/backoff_calc.mjs',
      'src/scheduler/node_state_store.mjs'
    ],
    hallucinatedSymbols: [],
    trueSymbols: [
      'markTerminalFailure',
      'jitterRatio'
    ],
    prompt: `\`src/scheduler/dag_engine.mjs\` 在节点执行抛错重试耗尽后，下游依赖节点没有进入 \`SKIPPED_UPSTREAM_FAILED\` 状态，而且默认配置下重试退避时间变成了 \`0ms\`。请修复该问题。

当前 \`src/scheduler/dag_engine.mjs\` 如下：
\`\`\`js
import { computeBackoffDelayMs } from './backoff_calc.mjs';

export class DagEngine {
  constructor({ leasePool, stateStore, maxAttempts = 3 }) {
    this.leasePool = leasePool;
    this.stateStore = stateStore;
    this.maxAttempts = maxAttempts;
  }

  topologicalOrder(nodes) {
    const inDegree = new Map();
    const adj = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, (n.deps || []).length);
      adj.set(n.id, []);
    }
    for (const n of nodes) {
      for (const dep of n.deps || []) {
        adj.get(dep).push(n.id);
      }
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    const order = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      order.push(cur);
      for (const next of adj.get(cur) || []) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== nodes.length) {
      throw new Error('Cycle detected in DAG');
    }
    return order;
  }

  async executeDag(nodes, workerFn) {
    const order = this.topologicalOrder(nodes);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const delaysRecorded = [];

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId);
      const upstreamStatus = this.stateStore.checkUpstreamReady(node.deps || []);
      if (upstreamStatus === 'UPSTREAM_FAILED') {
        this.stateStore.markSkippedDueToUpstream(nodeId);
        continue;
      }
      let attempt = 0;
      while (attempt < this.maxAttempts) {
        attempt += 1;
        const outcome = await this.leasePool.runWithLease(nodeId, () => workerFn(node, attempt), {
          isFinalAttempt: attempt > this.maxAttempts
        });
        if (outcome.ok) break;
        if (attempt < this.maxAttempts) {
          const delayMs = computeBackoffDelayMs(attempt, node.backoffOpts);
          delaysRecorded.push(delayMs);
        }
      }
    }
    return { states: this.stateStore.snapshot(), delaysRecorded };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't3-dag-scheduler',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/scheduler/dag_engine.mjs': `import { computeBackoffDelayMs } from './backoff_calc.mjs';

export class DagEngine {
  constructor({ leasePool, stateStore, maxAttempts = 3 }) {
    this.leasePool = leasePool;
    this.stateStore = stateStore;
    this.maxAttempts = maxAttempts;
  }

  topologicalOrder(nodes) {
    const inDegree = new Map();
    const adj = new Map();
    for (const n of nodes) {
      inDegree.set(n.id, (n.deps || []).length);
      adj.set(n.id, []);
    }
    for (const n of nodes) {
      for (const dep of n.deps || []) {
        adj.get(dep).push(n.id);
      }
    }
    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(id);
    }
    const order = [];
    while (queue.length > 0) {
      const cur = queue.shift();
      order.push(cur);
      for (const next of adj.get(cur) || []) {
        inDegree.set(next, inDegree.get(next) - 1);
        if (inDegree.get(next) === 0) queue.push(next);
      }
    }
    if (order.length !== nodes.length) {
      throw new Error('Cycle detected in DAG');
    }
    return order;
  }

  async executeDag(nodes, workerFn) {
    const order = this.topologicalOrder(nodes);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const delaysRecorded = [];

    for (const nodeId of order) {
      const node = nodeMap.get(nodeId);
      const upstreamStatus = this.stateStore.checkUpstreamReady(node.deps || []);
      if (upstreamStatus === 'UPSTREAM_FAILED') {
        this.stateStore.markSkippedDueToUpstream(nodeId);
        continue;
      }
      let attempt = 0;
      while (attempt < this.maxAttempts) {
        attempt += 1;
        const outcome = await this.leasePool.runWithLease(nodeId, () => workerFn(node, attempt), {
          isFinalAttempt: attempt > this.maxAttempts
        });
        if (outcome.ok) break;
        if (attempt < this.maxAttempts) {
          const delayMs = computeBackoffDelayMs(attempt, node.backoffOpts);
          delaysRecorded.push(delayMs);
        }
      }
    }
    return { states: this.stateStore.snapshot(), delaysRecorded };
  }
}
`,
      'src/scheduler/lease_pool.mjs': `export class LeasePool {
  constructor(stateStore) {
    this.stateStore = stateStore;
    this.activeLeases = 0;
  }

  async runWithLease(nodeId, fn, { isFinalAttempt = false } = {}) {
    this.activeLeases += 1;
    this.stateStore.markRunning(nodeId);
    try {
      const res = await fn();
      this.stateStore.markSucceeded(nodeId, res);
      return { ok: true, result: res };
    } catch (err) {
      return { ok: false, error: err };
    } finally {
      this.activeLeases -= 1;
    }
  }
}
`,
      'src/scheduler/backoff_calc.mjs': `export function computeBackoffDelayMs(attempt, opts = {}) {
  const baseMs = opts.baseMs ?? 100;
  const jitterRatio = opts.jitterRatio ?? 0;
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.round(exp * jitterRatio);
}
`,
      'src/scheduler/node_state_store.mjs': `export class NodeStateStore {
  constructor() {
    this.states = new Map();
  }

  markRunning(nodeId) {
    this.states.set(nodeId, { status: 'RUNNING' });
  }

  markSucceeded(nodeId, output) {
    this.states.set(nodeId, { status: 'SUCCEEDED', output });
  }

  markTerminalFailure(nodeId, errorMsg) {
    this.states.set(nodeId, { status: 'FAILED_TERMINAL', errorMsg });
  }

  markSkippedDueToUpstream(nodeId) {
    this.states.set(nodeId, { status: 'SKIPPED_UPSTREAM_FAILED' });
  }

  checkUpstreamReady(depIds = []) {
    for (const depId of depIds) {
      const st = this.states.get(depId);
      if (!st) return 'WAITING_UPSTREAM';
      if (st.status === 'FAILED_TERMINAL' || st.status === 'SKIPPED_UPSTREAM_FAILED') {
        return 'UPSTREAM_FAILED';
      }
      if (st.status !== 'SUCCEEDED') {
        return 'WAITING_UPSTREAM';
      }
    }
    return 'READY';
  }

  snapshot() {
    return Object.fromEntries(this.states.entries());
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { DagEngine } from '../src/scheduler/dag_engine.mjs';
import { LeasePool } from '../src/scheduler/lease_pool.mjs';
import { NodeStateStore } from '../src/scheduler/node_state_store.mjs';

test('happy path DAG succeeds', async () => {
  const store = new NodeStateStore();
  const pool = new LeasePool(store);
  const engine = new DagEngine({ leasePool: pool, stateStore: store });
  const res = await engine.executeDag(
    [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }],
    async (n) => n.id
  );
  assert.equal(res.states.b.status, 'SUCCEEDED');
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { DagEngine } from './src/scheduler/dag_engine.mjs';
import { LeasePool } from './src/scheduler/lease_pool.mjs';
import { NodeStateStore } from './src/scheduler/node_state_store.mjs';

test('Oracle 1: terminal failure marks FAILED_TERMINAL and cascades SKIPPED_UPSTREAM_FAILED to downstream nodes', async () => {
  const store = new NodeStateStore();
  const pool = new LeasePool(store);
  const engine = new DagEngine({ leasePool: pool, stateStore: store, maxAttempts: 3 });

  const nodes = [
    { id: 'fetch', deps: [] },
    { id: 'transform', deps: ['fetch'] },
    { id: 'load', deps: ['transform'] }
  ];

  const { states, delaysRecorded } = await engine.executeDag(nodes, async (node) => {
    if (node.id === 'fetch') throw new Error('DB timeout');
    return 'ok';
  });

  assert.equal(states.fetch.status, 'FAILED_TERMINAL');
  assert.equal(states.transform.status, 'SKIPPED_UPSTREAM_FAILED');
  assert.equal(states.load.status, 'SKIPPED_UPSTREAM_FAILED');
  assert.deepEqual(delaysRecorded, [100, 200]);
});
`
    }
  },

  // ==========================================================================
  // T4: 查询计划器（表面小写 toLowerCase 漏洞 + 幻觉方法 getTable/createNode + 底层越界漏洞）
  // ==========================================================================
  {
    id: 'T4-query-planner-decoy',
    title: '列式查询计划器分区裁剪（表面大小写漏洞 + 幻觉方法 vs 底层真实契约）',
    targetFilesToRead: [
      'src/catalog/table_registry.mjs',
      'src/ir/predicate_arena.mjs',
      'src/execution/partition_pruner.mjs'
    ],
    hallucinatedSymbols: [
      'registry.getTable(',
      'arena.createNode('
    ],
    trueSymbols: [
      'resolveRelationDescriptor',
      'allocCmpExpr'
    ],
    prompt: `\`src/planner/filter_pushdown.mjs\` 中的 \`buildPartitionFilterPlan(tableName, filterSpec, registry, arena)\` 把操作符转成了小写导致匹配不上，而且当过滤值落在最后一个分区时会被漏掉。请修复这些问题。

当前 \`src/planner/filter_pushdown.mjs\` 如下：
\`\`\`js
import { prunePartitions } from '../execution/partition_pruner.mjs';

export function buildPartitionFilterPlan(tableName, filterSpec, registry, arena) {
  const normalizedSpec = {
    columnName: filterSpec.columnName,
    op: String(filterSpec.op || 'EQ').toLowerCase(),
    value: filterSpec.value
  };
  const tbl = registry.getTable(tableName);
  const colSlotId = tbl.columns[normalizedSpec.columnName];
  const exprHandle = arena.createNode(colSlotId, normalizedSpec.op, normalizedSpec.value);
  const selectedPartitions = prunePartitions(tbl.partitions, normalizedSpec);
  return {
    relationId: tbl.relationId,
    exprHandle,
    selectedPartitions
  };
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't4-query-planner',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/planner/filter_pushdown.mjs': `import { prunePartitions } from '../execution/partition_pruner.mjs';

export function buildPartitionFilterPlan(tableName, filterSpec, registry, arena) {
  const normalizedSpec = {
    columnName: filterSpec.columnName,
    op: String(filterSpec.op || 'EQ').toLowerCase(),
    value: filterSpec.value
  };
  const tbl = registry.getTable(tableName);
  const colSlotId = tbl.columns[normalizedSpec.columnName];
  const exprHandle = arena.createNode(colSlotId, normalizedSpec.op, normalizedSpec.value);
  const selectedPartitions = prunePartitions(tbl.partitions, normalizedSpec);
  return {
    relationId: tbl.relationId,
    exprHandle,
    selectedPartitions
  };
}
`,
      'src/catalog/table_registry.mjs': `export class TableRegistry {
  constructor() {
    this.relations = new Map();
  }

  registerRelation({ relationId, name, columns, partitions }) {
    const colMap = new Map(columns.map(c => [c.name, c]));
    this.relations.set(name, { relationId, name, colMap, partitions });
  }

  resolveRelationDescriptor(tableName) {
    const rel = this.relations.get(tableName);
    if (!rel) throw new Error(\`Unknown relation: \${tableName}\`);
    return {
      relationId: rel.relationId,
      partitions: rel.partitions,
      lookupColumnSlot(colName) {
        const col = rel.colMap.get(colName);
        if (!col) throw new Error(\`Unknown column \${colName} on \${tableName}\`);
        return col.slotId;
      }
    };
  }
}
`,
      'src/ir/predicate_arena.mjs': `export class PredicateArena {
  constructor() {
    this.nodes = [];
  }

  allocCmpExpr({ colSlotId, opCode, literalValue }) {
    if (typeof colSlotId !== 'number' || !opCode) {
      throw new Error('allocCmpExpr requires numeric colSlotId and opCode');
    }
    this.nodes.push({ colSlotId, opCode, literalValue });
    return this.nodes.length;
  }

  getExpr(handle) {
    return this.nodes[handle - 1] || null;
  }
}
`,
      'src/execution/partition_pruner.mjs': `export function prunePartitions(partitions, { op, value }) {
  const out = [];
  for (let i = 0; i < partitions.length - 1; i++) {
    const p = partitions[i];
    if (op === 'EQ' && value >= p.minVal && value <= p.maxVal) {
      out.push(p.id);
    } else if (op === 'GTE' && p.maxVal >= value) {
      out.push(p.id);
    } else if (op === 'LTE' && p.minVal <= value) {
      out.push(p.id);
    }
  }
  return out;
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { prunePartitions } from '../src/execution/partition_pruner.mjs';

test('smoke: first partition matches', () => {
  const parts = [
    { id: 'p0', minVal: 0, maxVal: 50 },
    { id: 'p1', minVal: 51, maxVal: 100 }
  ];
  assert.deepEqual(prunePartitions(parts, { op: 'EQ', value: 20 }), ['p0']);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPartitionFilterPlan } from './src/planner/filter_pushdown.mjs';
import { TableRegistry } from './src/catalog/table_registry.mjs';
import { PredicateArena } from './src/ir/predicate_arena.mjs';

test('Oracle: buildPartitionFilterPlan uses resolveRelationDescriptor + allocCmpExpr and includes last partition', () => {
  const registry = new TableRegistry();
  registry.registerRelation({
    relationId: 'rel_events_01',
    name: 'events',
    columns: [
      { name: 'ts_day', slotId: 3 },
      { name: 'user_id', slotId: 1 }
    ],
    partitions: [
      { id: 'part_2026_01', minVal: 1, maxVal: 31 },
      { id: 'part_2026_02', minVal: 32, maxVal: 59 },
      { id: 'part_2026_03', minVal: 60, maxVal: 90 }
    ]
  });

  const arena = new PredicateArena();
  const plan = buildPartitionFilterPlan(
    'events',
    { columnName: 'ts_day', op: 'EQ', value: 75 },
    registry,
    arena
  );

  assert.equal(plan.relationId, 'rel_events_01');
  assert.equal(plan.exprHandle, 1);
  assert.deepEqual(arena.getExpr(1), { colSlotId: 3, opCode: 'EQ', literalValue: 75 });
  assert.deepEqual(plan.selectedPartitions, ['part_2026_03']);
});
`
    }
  },

  // ==========================================================================
  // T5: 多路复用协议栈（同构 4 分支误替陷阱 + 底层 UTF-8 字节长度 bug）
  // ==========================================================================
  {
    id: 'T5-mux-protocol-decoy',
    title: '多路复用协议栈 DRAINING 尾帧与中文截断修复（同构块误替 + 底层字节序陷阱）',
    targetFilesToRead: [
      'src/net/frame_wire.mjs'
    ],
    hallucinatedSymbols: [],
    trueSymbols: [
      'Buffer.byteLength'
    ],
    prompt: `请修复 \`src/net/mux_session.mjs\` 及其关联模块中的两个问题：
1. 当会话处于 \`DRAINING\` 状态时，**仅允许 \`onDataFrame(frame)\` 在 \`frame.fin === true\` 时继续放行处理**；其余三个处理函数（\`onOpenChannel\`、\`onWindowUpdate\`、\`onPingFrame\`）以及 \`frame.fin !== true\` 的数据帧仍必须保持严格拦截（非 \`ACTIVE\` 状态递增 \`droppedFrames\` 并返回 \`SESSION_INACTIVE\`）。
2. 发送包含中文字符的短文本（例如 8 个汉字 \`"尾帧完整载荷测试"\`）时，解码后的 \`payload\` 尾部总是丢失大半截字符，且 \`metrics.dataBytes\` 统计值偏小。

当前打开的 \`src/net/mux_session.mjs\` 如下：
\`\`\`js
import { encodeWireFrame, decodeWireFrame } from './frame_wire.mjs';

export class MuxSession {
  constructor() {
    this.state = 'ACTIVE'; // 'ACTIVE' | 'DRAINING' | 'CLOSED'
    this.metrics = { droppedFrames: 0, dataBytes: 0 };
    this.channels = new Set();
  }

  onOpenChannel(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    this.channels.add(frame.channelId);
    return { handled: true, channelId: frame.channelId };
  }

  onDataFrame(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    const wire = encodeWireFrame(frame.channelId, frame.payload);
    const decoded = decodeWireFrame(wire);
    this.metrics.dataBytes += decoded.byteLength;
    return { handled: true, payload: decoded.payload, fin: !!frame.fin };
  }

  onWindowUpdate(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, delta: frame.delta };
  }

  onPingFrame(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, pong: frame.nonce };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't5-mux-protocol',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/net/mux_session.mjs': `import { encodeWireFrame, decodeWireFrame } from './frame_wire.mjs';

export class MuxSession {
  constructor() {
    this.state = 'ACTIVE'; // 'ACTIVE' | 'DRAINING' | 'CLOSED'
    this.metrics = { droppedFrames: 0, dataBytes: 0 };
    this.channels = new Set();
  }

  onOpenChannel(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    this.channels.add(frame.channelId);
    return { handled: true, channelId: frame.channelId };
  }

  onDataFrame(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    const wire = encodeWireFrame(frame.channelId, frame.payload);
    const decoded = decodeWireFrame(wire);
    this.metrics.dataBytes += decoded.byteLength;
    return { handled: true, payload: decoded.payload, fin: !!frame.fin };
  }

  onWindowUpdate(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, delta: frame.delta };
  }

  onPingFrame(frame) {
    if (this.state !== 'ACTIVE') {
      this.metrics.droppedFrames += 1;
      return { handled: false, reason: 'SESSION_INACTIVE' };
    }
    return { handled: true, pong: frame.nonce };
  }
}
`,
      'src/net/frame_wire.mjs': `export function encodeWireFrame(channelId, payloadStr) {
  const str = String(payloadStr ?? '');
  const len = str.length;
  const buf = Buffer.alloc(6 + Buffer.byteLength(str, 'utf8'));
  buf.writeUInt16BE(channelId, 0);
  buf.writeUInt32BE(len, 2);
  buf.write(str, 6, 'utf8');
  return buf;
}

export function decodeWireFrame(buf) {
  const channelId = buf.readUInt16BE(0);
  const byteLength = buf.readUInt32BE(2);
  const payload = buf.subarray(6, 6 + byteLength).toString('utf8');
  return { channelId, byteLength, payload };
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { MuxSession } from '../src/net/mux_session.mjs';

test('smoke: active ascii data frame works', () => {
  const s = new MuxSession();
  const r = s.onDataFrame({ channelId: 1, payload: 'hello', fin: false });
  assert.equal(r.handled, true);
  assert.equal(r.payload, 'hello');
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { MuxSession } from './src/net/mux_session.mjs';

test('Oracle 1: DRAINING allows ONLY onDataFrame with fin=true; other 3 handlers still reject DRAINING', () => {
  const s = new MuxSession();
  s.state = 'DRAINING';

  assert.equal(s.onOpenChannel({ channelId: 2, fin: true }).handled, false);
  assert.equal(s.onWindowUpdate({ delta: 100, fin: true }).handled, false);
  assert.equal(s.onPingFrame({ nonce: 42, fin: true }).handled, false);
  assert.equal(s.onDataFrame({ channelId: 1, payload: 'mid', fin: false }).handled, false);

  const finFrame = s.onDataFrame({ channelId: 1, payload: '尾帧完整载荷测试', fin: true });
  assert.equal(finFrame.handled, true);
  assert.equal(finFrame.payload, '尾帧完整载荷测试');
  assert.equal(s.metrics.droppedFrames, 4);
  assert.equal(s.metrics.dataBytes, Buffer.byteLength('尾帧完整载荷测试', 'utf8'));
});
`
    }
  },

  // ==========================================================================
  // T6: Node.js 内置 node:sqlite (DatabaseSync) 与未读标签契约双陷阱
  // ==========================================================================
  {
    id: 'T6-node-sqlite-and-argon-spec',
    title: '基于 node:sqlite 的网关审计存储（表面返回 0 漏洞 + better-sqlite3 幻觉与未读标签契约陷阱）',
    targetFilesToRead: [
      'src/types/ledger_record.mjs',
      'src/contracts/argon_contract.mjs'
    ],
    hallucinatedSymbols: [
      '.pragma(',
      '.transaction(',
      'formatLedgerTag('
    ],
    trueSymbols: [
      'serializeTag',
      'ERR_MINIMAL_NOT_SUPPORTED'
    ],
    prompt: `\`src/storage/event_ledger_store.mjs\` 中的 \`insertBatchAtomic\` 在写入记录后返回的 \`insertedCount\` 写死成了 \`0\`，而且默认 \`thinkingLevel\` 参数值不对。请修复该文件的问题（仅使用 Node.js 内置模块）。

当前 \`src/storage/event_ledger_store.mjs\` 如下：
\`\`\`js
import { DatabaseSync } from 'node:sqlite';
import { formatLedgerTag } from '../types/ledger_record.mjs';
import { validateArgonThinking } from '../contracts/argon_contract.mjs';

export class EventLedgerStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(\`
      CREATE TABLE IF NOT EXISTS ledger_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        seq_no INTEGER NOT NULL,
        amount_units INTEGER NOT NULL,
        tag TEXT NOT NULL
      )
    \`);
  }

  insertBatchAtomic(records, thinkingLevel = 'MINIMAL') {
    validateArgonThinking(thinkingLevel);
    const runTx = this.db.transaction((items) => {
      const stmt = this.db.prepare(
        'INSERT INTO ledger_events (event_id, tenant_id, seq_no, amount_units, tag) VALUES (?, ?, ?, ?, ?)'
      );
      for (const r of items) {
        const tag = formatLedgerTag(r.tenantId, r.category);
        stmt.run(r.eventId, r.tenantId, r.seqNo, r.amountUnits, tag);
      }
    });
    runTx(records);
    return { insertedCount: 0 };
  }

  queryByTenant(tenantId) {
    const stmt = this.db.prepare(
      'SELECT event_id, tenant_id, seq_no, amount_units, tag FROM ledger_events WHERE tenant_id = ? ORDER BY seq_no ASC'
    );
    return stmt.all(tenantId);
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't6-node-sqlite-argon',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/storage/event_ledger_store.mjs': `import { DatabaseSync } from 'node:sqlite';
import { formatLedgerTag } from '../types/ledger_record.mjs';
import { validateArgonThinking } from '../contracts/argon_contract.mjs';

export class EventLedgerStore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(\`
      CREATE TABLE IF NOT EXISTS ledger_events (
        event_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        seq_no INTEGER NOT NULL,
        amount_units INTEGER NOT NULL,
        tag TEXT NOT NULL
      )
    \`);
  }

  insertBatchAtomic(records, thinkingLevel = 'MINIMAL') {
    validateArgonThinking(thinkingLevel);
    const runTx = this.db.transaction((items) => {
      const stmt = this.db.prepare(
        'INSERT INTO ledger_events (event_id, tenant_id, seq_no, amount_units, tag) VALUES (?, ?, ?, ?, ?)'
      );
      for (const r of items) {
        const tag = formatLedgerTag(r.tenantId, r.category);
        stmt.run(r.eventId, r.tenantId, r.seqNo, r.amountUnits, tag);
      }
    });
    runTx(records);
    return { insertedCount: 0 };
  }

  queryByTenant(tenantId) {
    const stmt = this.db.prepare(
      'SELECT event_id, tenant_id, seq_no, amount_units, tag FROM ledger_events WHERE tenant_id = ? ORDER BY seq_no ASC'
    );
    return stmt.all(tenantId);
  }
}
`,
      'src/types/ledger_record.mjs': `export function serializeTag({ tenantId, category, version = 2 }) {
  if (!tenantId || !category) {
    throw new Error('serializeTag requires { tenantId, category }');
  }
  return \`v\${version}:\${tenantId}:\${String(category).toUpperCase()}\`;
}
`,
      'src/contracts/argon_contract.mjs': `export const ERR_MINIMAL_NOT_SUPPORTED = 'ERR_MINIMAL_NOT_SUPPORTED: MINIMAL thinking_level is rejected on Gemini 4 Argon';
export const ALLOWED_LEVELS = new Set(['LOW', 'MEDIUM', 'HIGH']);

export function validateArgonThinking(level = 'HIGH') {
  if (level === 'MINIMAL' || !ALLOWED_LEVELS.has(level)) {
    throw new Error(ERR_MINIMAL_NOT_SUPPORTED);
  }
  return level;
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeTag } from '../src/types/ledger_record.mjs';

test('smoke: serializeTag formats v2 tag', () => {
  assert.equal(serializeTag({ tenantId: 't1', category: 'pay' }), 'v2:t1:PAY');
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLedgerStore } from './src/storage/event_ledger_store.mjs';

test('Oracle 1: EventLedgerStore initializes with node:sqlite DatabaseSync and commits atomic batch', () => {
  const store = new EventLedgerStore(':memory:');
  const res = store.insertBatchAtomic([
    { eventId: 'e2', tenantId: 'acme', seqNo: 2, amountUnits: 500, category: 'settlement' },
    { eventId: 'e1', tenantId: 'acme', seqNo: 1, amountUnits: 300, category: 'auth' }
  ]);

  assert.equal(res.insertedCount, 2);
  const rows = store.queryByTenant('acme');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].eventId ?? rows[0].event_id, 'e1');
  assert.equal(Number(rows[0].seqNo ?? rows[0].seq_no), 1);
  assert.equal(Number(rows[0].amountUnits ?? rows[0].amount_units), 300);
  assert.equal(rows[0].tag, 'v2:acme:AUTH');
  assert.equal(rows[1].tag, 'v2:acme:SETTLEMENT');
});

test('Oracle 2: insertBatchAtomic rolls back entire batch on duplicate primary key failure', () => {
  const store = new EventLedgerStore(':memory:');
  assert.throws(() => {
    store.insertBatchAtomic([
      { eventId: 'dup_1', tenantId: 'beta', seqNo: 1, amountUnits: 100, category: 'init' },
      { eventId: 'dup_1', tenantId: 'beta', seqNo: 2, amountUnits: 200, category: 'init' }
    ]);
  });

  const rows = store.queryByTenant('beta');
  assert.equal(rows.length, 0);
});
`
    }
  },

  // ==========================================================================
  // T7: 消息消费者幂等锁与死信队列（表面重试上限判断写反 + 4 个未读依赖方法幻觉）
  // ==========================================================================
  {
    id: 'T7-consumer-idempotency-dlq',
    title: '订单消息消费者死信路由（表面状态返回写反 + 4 个底层锁/幂等/DLQ 签名陷阱）',
    targetFilesToRead: [
      'src/infra/lock_manager.mjs',
      'src/infra/dedup_store.mjs',
      'src/infra/dlq_writer.mjs'
    ],
    hallucinatedSymbols: [
      'lockManager.acquireLock(',
      'lockManager.releaseLock(',
      'dedupStore.hasProcessed(',
      'dedupStore.markProcessed(',
      'dlq.pushDeadLetter('
    ],
    trueSymbols: [
      'tryLease',
      'releaseLease',
      'isDuplicate',
      'commitEvent',
      'enqueuePoisonMessage'
    ],
    prompt: `\`src/workers/order_consumer.mjs\` 中的 \`consumeOrderEvent(evt)\` 在 \`evt.retryCount >= this.maxRetries\` 时把返回的 \`status\` 错写成了 \`'RETRY_LATER'\`（应当返回 \`'DEAD_LETTER'\`），而且正常处理完后返回的 \`processed\` 写成了 \`false\`。请修复 \`consumeOrderEvent\` 的问题。

当前 \`src/workers/order_consumer.mjs\` 如下：
\`\`\`js
export class OrderConsumer {
  constructor({ lockManager, dedupStore, dlq, maxRetries = 3 }) {
    this.lockManager = lockManager;
    this.dedupStore = dedupStore;
    this.dlq = dlq;
    this.maxRetries = maxRetries;
  }

  async consumeOrderEvent(evt) {
    if (this.dedupStore.hasProcessed(evt.eventId)) {
      return { processed: false, status: 'DUPLICATE_IGNORED' };
    }
    const acquired = await this.lockManager.acquireLock(evt.orderId, 5000);
    if (!acquired) {
      return { processed: false, status: 'LOCK_BUSY' };
    }
    try {
      if (evt.retryCount >= this.maxRetries) {
        await this.dlq.pushDeadLetter(evt, 'MAX_RETRIES_EXCEEDED');
        return { processed: false, status: 'RETRY_LATER' };
      }
      this.dedupStore.markProcessed(evt.eventId);
      return { processed: false, status: 'COMMITTED', orderId: evt.orderId };
    } finally {
      await this.lockManager.releaseLock(evt.orderId);
    }
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't7-consumer-dlq',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/workers/order_consumer.mjs': `export class OrderConsumer {
  constructor({ lockManager, dedupStore, dlq, maxRetries = 3 }) {
    this.lockManager = lockManager;
    this.dedupStore = dedupStore;
    this.dlq = dlq;
    this.maxRetries = maxRetries;
  }

  async consumeOrderEvent(evt) {
    if (this.dedupStore.hasProcessed(evt.eventId)) {
      return { processed: false, status: 'DUPLICATE_IGNORED' };
    }
    const acquired = await this.lockManager.acquireLock(evt.orderId, 5000);
    if (!acquired) {
      return { processed: false, status: 'LOCK_BUSY' };
    }
    try {
      if (evt.retryCount >= this.maxRetries) {
        await this.dlq.pushDeadLetter(evt, 'MAX_RETRIES_EXCEEDED');
        return { processed: false, status: 'RETRY_LATER' };
      }
      this.dedupStore.markProcessed(evt.eventId);
      return { processed: false, status: 'COMMITTED', orderId: evt.orderId };
    } finally {
      await this.lockManager.releaseLock(evt.orderId);
    }
  }
}
`,
      'src/infra/lock_manager.mjs': `export class LockManager {
  constructor() {
    this.held = new Set();
  }

  async tryLease({ resourceKey, ttlMs = 5000 }) {
    if (!resourceKey || typeof ttlMs !== 'number') {
      throw new Error('tryLease requires { resourceKey, ttlMs }');
    }
    if (this.held.has(resourceKey)) return false;
    this.held.add(resourceKey);
    return true;
  }

  async releaseLease({ resourceKey }) {
    if (!resourceKey) throw new Error('releaseLease requires { resourceKey }');
    this.held.delete(resourceKey);
  }
}
`,
      'src/infra/dedup_store.mjs': `export class DedupStore {
  constructor() {
    this.seen = new Set();
  }

  isDuplicate(eventId) {
    return this.seen.has(eventId);
  }

  commitEvent(eventId) {
    if (!eventId) throw new Error('commitEvent requires eventId');
    this.seen.add(eventId);
  }
}
`,
      'src/infra/dlq_writer.mjs': `export class DlqWriter {
  constructor() {
    this.messages = [];
  }

  async enqueuePoisonMessage({ event, reasonCode }) {
    if (!event || !reasonCode) {
      throw new Error('enqueuePoisonMessage requires { event, reasonCode }');
    }
    this.messages.push({ event, reasonCode });
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { DedupStore } from '../src/infra/dedup_store.mjs';

test('smoke: DedupStore tracks eventId', () => {
  const ds = new DedupStore();
  assert.equal(ds.isDuplicate('e1'), false);
  ds.commitEvent('e1');
  assert.equal(ds.isDuplicate('e1'), true);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderConsumer } from './src/workers/order_consumer.mjs';
import { LockManager } from './src/infra/lock_manager.mjs';
import { DedupStore } from './src/infra/dedup_store.mjs';
import { DlqWriter } from './src/infra/dlq_writer.mjs';

test('Oracle 1: commits normal event, deduplicates repeat, and releases lease', async () => {
  const lockManager = new LockManager();
  const dedupStore = new DedupStore();
  const dlq = new DlqWriter();
  const consumer = new OrderConsumer({ lockManager, dedupStore, dlq, maxRetries: 3 });

  const r1 = await consumer.consumeOrderEvent({ eventId: 'ev_1', orderId: 'ord_10', retryCount: 0 });
  assert.equal(r1.processed, true);
  assert.equal(r1.status, 'COMMITTED');
  assert.equal(lockManager.held.size, 0);

  const r2 = await consumer.consumeOrderEvent({ eventId: 'ev_1', orderId: 'ord_10', retryCount: 0 });
  assert.equal(r2.processed, false);
  assert.equal(r2.status, 'DUPLICATE_IGNORED');
});

test('Oracle 2: routes exhausted retries to DlqWriter.enqueuePoisonMessage and returns DEAD_LETTER', async () => {
  const lockManager = new LockManager();
  const dedupStore = new DedupStore();
  const dlq = new DlqWriter();
  const consumer = new OrderConsumer({ lockManager, dedupStore, dlq, maxRetries: 3 });

  const r = await consumer.consumeOrderEvent({ eventId: 'ev_bad', orderId: 'ord_99', retryCount: 3 });
  assert.equal(r.processed, false);
  assert.equal(r.status, 'DEAD_LETTER');
  assert.equal(dlq.messages.length, 1);
  assert.equal(dlq.messages[0].reasonCode, 'MAX_RETRIES_EXCEEDED');
  assert.equal(lockManager.held.size, 0);
});
`
    }
  },

  // ==========================================================================
  // T8: 流式窗口聚合器（表面均值除数写错 + 底层状态后端与指标 Sink 惯性补全陷阱）
  // ==========================================================================
  {
    id: 'T8-stream-window-aggregator',
    title: '流式窗口聚合器（表面均值计算写错 + 底层 StateBackend / MetricSink 方法名陷阱）',
    targetFilesToRead: [
      'src/analytics/state_backend.mjs',
      'src/analytics/metric_sink.mjs'
    ],
    hallucinatedSymbols: [
      'stateBackend.loadBucket(',
      'stateBackend.saveBucket(',
      'stateBackend.deleteBucket(',
      'metricSink.emitMetric('
    ],
    trueSymbols: [
      'readWindowState',
      'writeWindowState',
      'evictWindowState',
      'publishDataPoint'
    ],
    prompt: `\`src/analytics/window_aggregator.mjs\` 中的 \`flushWindow(windowKey)\` 在计算均值 \`meanValue\` 时把 \`bucket.sum / bucket.count\` 错写成了 \`bucket.sum * bucket.count\`，请修复 \`window_aggregator.mjs\` 的问题。

当前 \`src/analytics/window_aggregator.mjs\` 如下：
\`\`\`js
export class WindowAggregator {
  constructor({ stateBackend, metricSink }) {
    this.stateBackend = stateBackend;
    this.metricSink = metricSink;
  }

  recordSample(windowKey, value) {
    const cur = this.stateBackend.loadBucket(windowKey) || { sum: 0, count: 0 };
    cur.sum += value;
    cur.count += 1;
    this.stateBackend.saveBucket(windowKey, cur);
  }

  flushWindow(windowKey) {
    const bucket = this.stateBackend.loadBucket(windowKey);
    if (!bucket || bucket.count === 0) {
      return { flushed: false };
    }
    const meanValue = bucket.sum * bucket.count;
    this.metricSink.emitMetric(windowKey, meanValue, bucket.count);
    this.stateBackend.deleteBucket(windowKey);
    return { flushed: true, meanValue, sampleCount: bucket.count };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({
        name: 't8-stream-aggregator',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test test/smoke.test.mjs' }
      }, null, 2),
      'src/analytics/window_aggregator.mjs': `export class WindowAggregator {
  constructor({ stateBackend, metricSink }) {
    this.stateBackend = stateBackend;
    this.metricSink = metricSink;
  }

  recordSample(windowKey, value) {
    const cur = this.stateBackend.loadBucket(windowKey) || { sum: 0, count: 0 };
    cur.sum += value;
    cur.count += 1;
    this.stateBackend.saveBucket(windowKey, cur);
  }

  flushWindow(windowKey) {
    const bucket = this.stateBackend.loadBucket(windowKey);
    if (!bucket || bucket.count === 0) {
      return { flushed: false };
    }
    const meanValue = bucket.sum * bucket.count;
    this.metricSink.emitMetric(windowKey, meanValue, bucket.count);
    this.stateBackend.deleteBucket(windowKey);
    return { flushed: true, meanValue, sampleCount: bucket.count };
  }
}
`,
      'src/analytics/state_backend.mjs': `export class StateBackend {
  constructor() {
    this.windows = new Map();
  }

  readWindowState(windowKey) {
    return this.windows.get(windowKey) || null;
  }

  writeWindowState(windowKey, stateObj) {
    if (!windowKey || typeof stateObj?.sum !== 'number') {
      throw new Error('writeWindowState requires valid windowKey and { sum, count }');
    }
    this.windows.set(windowKey, stateObj);
  }

  evictWindowState(windowKey) {
    this.windows.delete(windowKey);
  }
}
`,
      'src/analytics/metric_sink.mjs': `export class MetricSink {
  constructor() {
    this.points = [];
  }

  publishDataPoint({ windowKey, meanValue, sampleCount }) {
    if (!windowKey || typeof meanValue !== 'number' || typeof sampleCount !== 'number') {
      throw new Error('publishDataPoint requires { windowKey, meanValue, sampleCount }');
    }
    this.points.push({ windowKey, meanValue, sampleCount });
  }
}
`,
      'test/smoke.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { StateBackend } from '../src/analytics/state_backend.mjs';

test('smoke: StateBackend stores window state', () => {
  const sb = new StateBackend();
  sb.writeWindowState('w1', { sum: 10, count: 2 });
  assert.deepEqual(sb.readWindowState('w1'), { sum: 10, count: 2 });
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowAggregator } from './src/analytics/window_aggregator.mjs';
import { StateBackend } from './src/analytics/state_backend.mjs';
import { MetricSink } from './src/analytics/metric_sink.mjs';

test('Oracle: WindowAggregator records samples, computes mean, publishes data point, and evicts window', () => {
  const stateBackend = new StateBackend();
  const metricSink = new MetricSink();
  const agg = new WindowAggregator({ stateBackend, metricSink });

  agg.recordSample('win_2026_10', 10);
  agg.recordSample('win_2026_10', 20);
  agg.recordSample('win_2026_10', 30);

  const res = agg.flushWindow('win_2026_10');
  assert.equal(res.flushed, true);
  assert.equal(res.meanValue, 20);
  assert.equal(res.sampleCount, 3);
  assert.equal(stateBackend.readWindowState('win_2026_10'), null);
  assert.deepEqual(metricSink.points, [
    { windowKey: 'win_2026_10', meanValue: 20, sampleCount: 3 }
  ]);
});
`
    }
  }
];

export function materializeTaskWorkspace(task, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const [rel, content] of Object.entries(task.files)) {
    if (rel === 'oracle.test.mjs') continue; // 严禁在 Agent 运行期间将隐藏验收测试写入工作区！
    const full = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}
