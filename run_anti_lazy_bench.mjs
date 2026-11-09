import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  loadApiConfig,
  AGENT_TOOLS,
  executeToolCall,
  callArgonChat
} from './harness.mjs';

const STUDY_DIR = path.resolve(".");
const LAZY_RUNS_DIR = path.join(STUDY_DIR, 'anti-lazy-v3-runs');

// ============================================================================
// 3 组对比系统提示词：
// 1. control_stock: 默认原版
// 2. tier4_surgical_only: 仅含“最小改动原则”（验证单向强调最小改动是否加剧模糊许愿下的敷衍偷懒）
// 3. tier4_holistic_wish: 自适应意图分流（精确排障走最小改动；模糊功能许愿走完整工程考量与边界防御）
// ============================================================================
export const LAZY_PROMPT_VARIANTS = {
  control_stock: `SPECIAL INSTRUCTION: think silently if needed. EFFORT LEVEL: 1.00.
Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.

You are an expert AI coding assistant. Keep your responses concise. Use tools to complete the user's request efficiently.`,

  tier4_surgical_only: `You are an expert AI coding assistant.
- **Grounding Override**: Never guess unread files or symbols; call \`read_file\` first.
- **Surgical Scope**: Make the smallest correct change. Touch the fewest lines necessary and do only what is explicitly requested.
- **Clean Tool Turns**: Emit tool calls directly without prose preambles.`,

  tier4_holistic_wish: `You are an expert AI coding assistant.
- **Argon Grounding Override (Knowledge cutoff: March 2026)**: Probe through March 2026 without biasing toward older APIs. For workspace code, "do not abstain from low confidence or hedge" is REVERSED: on low confidence about unread files/symbols, ABSTAIN from guessing and call \`read_file\` first.
- **Adaptive Scope & Anti-Laziness Mandate (Surgical on Bugfixes, Holistic on Feature Wishes)**:
  - For **narrow bugfixes** on broken lines: keep the diff surgical.
  - For **feature requests, module implementations, or brief/vague user wishes**: NEVER settle for a lazy happy-path shortcut or wrap up early! In your internal thinking (never stop to ask permission in chat), proactively infer the complete engineering requirements a principal systems engineer would build:
    1. **Concurrency, Atomicity & Failure Recovery**: Guard against in-flight \`Promise.all\` race conditions (coalesce/lock pending keys), clean up or roll back state when downstream calls fail so retries succeed, prevent mutation of shared default objects (deep clone), and defend against prototype pollution (\`__proto__\`) or regex syntax injection.
    2. **Algorithmic & Domain Depth**: Never use naive one-liner shortcuts where real domain logic is needed—implement multi-term tokenization, title-weighted relevance scoring, and prefix/fuzzy matching for search; deep recursive object merging and env-var type coercion for config loaders; version ordering, SHA-256 checksum drift detection, atomic transactions, and rollback for DB migrators; payload-mismatch conflict detection (409) and expiring sliding windows for idempotency/rate-limiting.
    3. **Mandatory End-to-End Verification**: Immediately write the code via tool calls and run a thorough \`node -e\` verification via \`run_command\` testing concurrency, failure recovery, and edge cases before finishing.`
};

// ============================================================================
// 4 道「9~12字随口模糊许愿」任务 + 100% 纯动态行为测试评分器（每题 6 项真实验收测试）
// ============================================================================
export const WISH_TASKS = [
  // --------------------------------------------------------------------------
  // V1: 随口许愿 1：“帮我给 src/checkout.mjs 的下单接口加个防重复提交和限流。”
  // --------------------------------------------------------------------------
  {
    id: 'V1-wish-checkout-guard',
    domain: '后端并发与高可用接口',
    title: '随口许愿 1：“帮我给下单接口加个防重复提交和限流”（12字模糊许愿）',
    wishPrompt: `帮我给 \`src/checkout.mjs\` 里的 \`CheckoutController.handleCheckout(req)\` 加上防重复提交和限流功能（已提供代码，无需先 list_dir，直接修改并验证）。

当前 \`src/checkout.mjs\` 如下：
\`\`\`js
export class CheckoutController {
  constructor(walletService, options = {}) {
    this.walletService = walletService;
    this.options = options;
  }

  async handleCheckout(req) {
    // req: { idempotencyKey, userId, amount, itemId }
    const receipt = await this.walletService.debit(req.userId, req.amount, req.itemId);
    return { status: 200, receipt };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({ name: 'v1-checkout', version: '1.0.0', type: 'module' }, null, 2),
      'src/checkout.mjs': `export class CheckoutController {
  constructor(walletService, options = {}) {
    this.walletService = walletService;
    this.options = options;
  }

  async handleCheckout(req) {
    // req: { idempotencyKey, userId, amount, itemId }
    const receipt = await this.walletService.debit(req.userId, req.amount, req.itemId);
    return { status: 200, receipt };
  }
}
`
    },
    probeCode: `
import { CheckoutController } from './src/checkout.mjs';
import fs from 'node:fs';

const code = fs.readFileSync('./src/checkout.mjs', 'utf8');
const checks = {
  linesCount: code.split('\\n').length,
  t1_sequential_idempotency: false,
  t2_inflight_concurrent_race_safe: false,
  t3_downstream_error_allows_retry: false,
  t4_payload_mismatch_conflict_rejected: false,
  t5_ratelimit_blocks_and_window_recovers: false,
  t6_input_validation_guards: false
};

(async () => {
  // T1 & T2: Sequential + In-flight Promise.all concurrency race deduplication
  try {
    let debitCalls = 0;
    const wallet = {
      async debit(u, a, item) {
        debitCalls += 1;
        await new Promise(r => setTimeout(r, 35));
        return { txId: 'tx_' + debitCalls, u, a, item };
      }
    };
    const ctrl = new CheckoutController(wallet, { maxRequests: 50, limit: 50, windowMs: 1000 });
    const req = { idempotencyKey: 'idem_race_1', userId: 'u1', amount: 100, itemId: 'sku_1' };
    const [r1, r2] = await Promise.all([ctrl.handleCheckout(req), ctrl.handleCheckout(req)]);
    const r3 = await ctrl.handleCheckout(req);
    if (debitCalls === 1 && r1?.status === 200 && r3?.status === 200) {
      checks.t1_sequential_idempotency = true;
      checks.t2_inflight_concurrent_race_safe = true;
    } else if (debitCalls === 2) {
      const r4 = await ctrl.handleCheckout(req);
      if (debitCalls === 2 && r4?.status === 200) checks.t1_sequential_idempotency = true;
    }

    // T4: Reusing 'idem_race_1' with a tampered amount (9999 instead of 100) must be rejected (409/400/422 or throw)
    try {
      const bad = await ctrl.handleCheckout({ idempotencyKey: 'idem_race_1', userId: 'u1', amount: 9999, itemId: 'sku_2' });
      if (!bad || bad.status >= 400 || bad.error) {
        checks.t4_payload_mismatch_conflict_rejected = true;
      }
    } catch {
      checks.t4_payload_mismatch_conflict_rejected = true;
    }
  } catch {}

  // T3: Downstream error cleanup -> retrying the same idempotencyKey after a failed debit must succeed!
  try {
    let calls = 0;
    const flakyWallet = {
      async debit(u, a) {
        calls += 1;
        if (calls === 1) throw new Error('DB_CONN_LOST');
        return { txId: 'tx_recovered', u, a };
      }
    };
    const ctrl = new CheckoutController(flakyWallet, { maxRequests: 50, limit: 50 });
    const req = { idempotencyKey: 'idem_flaky', userId: 'u2', amount: 200, itemId: 'sku_1' };
    try { await ctrl.handleCheckout(req); } catch {}
    const retryRes = await ctrl.handleCheckout(req);
    if (retryRes && retryRes.status === 200 && retryRes.receipt?.txId === 'tx_recovered') {
      checks.t3_downstream_error_allows_retry = true;
    }
  } catch {}

  // T5: Rate limiting blocks burst AND recovers after windowMs
  try {
    const wallet = { async debit() { return { txId: 'ok' }; } };
    const ctrl = new CheckoutController(wallet, {
      maxRequests: 2, limit: 2, capacity: 2, windowMs: 80, refillRate: 25,
      rateLimit: { maxRequests: 2, limit: 2, windowMs: 80 }
    });
    let blocked = false;
    for (let i = 0; i < 15; i++) {
      try {
        const r = await ctrl.handleCheckout({ idempotencyKey: 'rl_' + i, userId: 'u_burst', amount: 10, itemId: 's' });
        if (r && (r.status === 429 || r.error || r.status >= 400)) { blocked = true; break; }
      } catch { blocked = true; break; }
    }
    if (blocked) {
      await new Promise(r => setTimeout(r, 110));
      const afterWait = await ctrl.handleCheckout({ idempotencyKey: 'rl_after', userId: 'u_burst', amount: 10, itemId: 's' });
      if (afterWait && afterWait.status === 200) {
        checks.t5_ratelimit_blocks_and_window_recovers = true;
      }
    }
  } catch {}

  // T6: Rejects invalid/negative amount or missing userId
  try {
    const wallet = { async debit() { return { txId: 'ok' }; } };
    const ctrl = new CheckoutController(wallet);
    try {
      const bad = await ctrl.handleCheckout({ idempotencyKey: 'bad_1', userId: '', amount: -50 });
      if (!bad || bad.status >= 400 || bad.error) checks.t6_input_validation_guards = true;
    } catch {
      checks.t6_input_validation_guards = true;
    }
  } catch {}

  console.log(JSON.stringify(checks));
})();
`
  },

  // --------------------------------------------------------------------------
  // V2: 随口许愿 2：“帮我把 src/migrator.mjs 里的数据库迁移功能实现完善一下。”
  // --------------------------------------------------------------------------
  {
    id: 'V2-wish-sqlite-migrator',
    domain: '数据库工具与事务安全',
    title: '随口许愿 2：“帮我把数据库迁移功能实现完善一下”（12字模糊许愿）',
    wishPrompt: `帮我把 \`src/migrator.mjs\` 里的数据库迁移器实现完善一下（使用内置 \`node:sqlite\`，已提供代码，无需先 list_dir，直接修改并验证）。

当前 \`src/migrator.mjs\` 如下：
\`\`\`js
import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
  }

  migrate(migrations) {
    // migrations: Array<{ version: number, name: string, up: string, down?: string }>
    for (const m of migrations) {
      this.db.exec(m.up);
    }
    return { applied: migrations.length };
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({ name: 'v2-migrator', version: '1.0.0', type: 'module' }, null, 2),
      'src/migrator.mjs': `import { DatabaseSync } from 'node:sqlite';

export class Migrator {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
  }

  migrate(migrations) {
    // migrations: Array<{ version: number, name: string, up: string, down?: string }>
    for (const m of migrations) {
      this.db.exec(m.up);
    }
    return { applied: migrations.length };
  }
}
`
    },
    probeCode: `
import { Migrator } from './src/migrator.mjs';
import fs from 'node:fs';

const code = fs.readFileSync('./src/migrator.mjs', 'utf8');
const checks = {
  linesCount: code.split('\\n').length,
  t1_idempotent_second_run_skips: false,
  t2_sorts_out_of_order_versions: false,
  t3_atomic_rollback_on_failed_migration: false,
  t4_detects_checksum_tampering: false,
  t5_supports_down_rollback: false,
  t6_supports_status_or_dryrun: false
};

(async () => {
  // T1 & T2: Out-of-order migrations [v2 depends on v1, passed as [v2, v1]] + Idempotent 2nd run
  try {
    const m = new Migrator(':memory:');
    const migs = [
      { version: 2, name: 'insert_seed', up: "INSERT INTO accounts (id, name) VALUES (1, 'alice');", down: "DELETE FROM accounts WHERE id = 1;" },
      { version: 1, name: 'create_accounts', up: "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);", down: "DROP TABLE accounts;" }
    ];
    await m.migrate(migs);
    const rows = m.db.prepare('SELECT name FROM accounts WHERE id = 1').all();
    if (rows.length === 1 && rows[0].name === 'alice') {
      checks.t2_sorts_out_of_order_versions = true;
    }
    const r2 = await m.migrate(migs);
    const count2 = typeof r2 === 'number' ? r2 : (Array.isArray(r2?.applied) ? r2.applied.length : (r2?.applied ?? r2?.count ?? -1));
    if (count2 === 0) {
      checks.t1_idempotent_second_run_skips = true;
    }
  } catch {}

  // T3: Atomic rollback when a migration fails mid-way
  try {
    const m = new Migrator(':memory:');
    try {
      await m.migrate([
        { version: 1, name: 'partial_fail', up: "CREATE TABLE temp_partial (id INT); INSERT INTO non_existent_tbl VALUES (1);", down: "DROP TABLE temp_partial;" }
      ]);
    } catch {}
    const tbls = m.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temp_partial'").all();
    if (tbls.length === 0) {
      checks.t3_atomic_rollback_on_failed_migration = true;
    }
  } catch {}

  // T4: Checksum tamper detection (modifying 'up' SQL of an already-applied migration throws or returns error)
  try {
    const m = new Migrator(':memory:');
    await m.migrate([{ version: 1, name: 'init', up: 'CREATE TABLE t1 (id INT);' }]);
    let detected = false;
    try {
      const r = await m.migrate([{ version: 1, name: 'init', up: 'CREATE TABLE t1 (id INT, tampered TEXT);' }]);
      if (r && (r.error || r.ok === false || r.tampered)) detected = true;
    } catch {
      detected = true;
    }
    checks.t4_detects_checksum_tampering = detected;
  } catch {}

  // T5: Supports rolling back (rollback / down / migrateDown)
  try {
    const m = new Migrator(':memory:');
    const migs = [
      { version: 1, name: 'c1', up: 'CREATE TABLE rb_test (id INT);', down: 'DROP TABLE rb_test;' }
    ];
    await m.migrate(migs);
    const rbFn = m.rollback || m.down || m.migrateDown;
    if (typeof rbFn === 'function') {
      await rbFn.call(m, migs, 1);
      const tbls = m.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rb_test'").all();
      if (tbls.length === 0) checks.t5_supports_down_rollback = true;
    }
  } catch {}

  // T6: Status inspection or dry-run
  if (typeof Migrator.prototype.status === 'function' || typeof Migrator.prototype.getStatus === 'function' || typeof Migrator.prototype.getApplied === 'function' || /dryRun/i.test(code)) {
    checks.t6_supports_status_or_dryrun = true;
  }

  console.log(JSON.stringify(checks));
})();
`
  },

  // --------------------------------------------------------------------------
  // V3: 随口许愿 3：“帮我把 src/article_search.mjs 的搜索功能做得好用点。”
  // --------------------------------------------------------------------------
  {
    id: 'V3-wish-article-search',
    domain: '搜索排序与容错算法',
    title: '随口许愿 3：“帮我把文章搜索功能做得好用点”（11字模糊许愿）',
    wishPrompt: `当前 \`src/article_search.mjs\` 的搜索太简陋了，帮我把它的搜索功能做得更好用、更完善（保留 \`ArticleSearch\` 类及 \`add(doc)\` / \`search(query, options)\` 接口兼容，无需先 list_dir，直接修改并验证）。

当前 \`src/article_search.mjs\` 如下：
\`\`\`js
export class ArticleSearch {
  constructor() {
    this.docs = [];
  }

  add(doc) {
    // doc: { id, title, body, tags?: string[] }
    this.docs.push(doc);
  }

  search(query, options = {}) {
    return this.docs.filter(d => d.title.includes(query) || d.body.includes(query));
  }
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({ name: 'v3-search', version: '1.0.0', type: 'module' }, null, 2),
      'src/article_search.mjs': `export class ArticleSearch {
  constructor() {
    this.docs = [];
  }

  add(doc) {
    // doc: { id, title, body, tags?: string[] }
    this.docs.push(doc);
  }

  search(query, options = {}) {
    return this.docs.filter(d => d.title.includes(query) || d.body.includes(query));
  }
}
`
    },
    probeCode: `
import { ArticleSearch } from './src/article_search.mjs';
import fs from 'node:fs';

const code = fs.readFileSync('./src/article_search.mjs', 'utf8');
const checks = {
  linesCount: code.split('\\n').length,
  t1_multi_word_non_adjacent_match: false,
  t2_relevance_ranking_title_boost: false,
  t3_prefix_or_fuzzy_typo_match: false,
  t4_regex_special_chars_safe: false,
  t5_tag_filtering_support: false,
  t6_dedup_or_remove_update_doc: false
};

function normList(res) {
  const arr = Array.isArray(res) ? res : (res?.results || res?.items || res?.hits || []);
  return arr.map(x => x?.id || x?.doc?.id || x?.item?.id || x?.document?.id);
}

try {
  const s = new ArticleSearch();
  s.add({ id: 'a1', title: 'Introduction to Programming', body: 'This guide covers distributed systems and how consensus protocols work in practice.', tags: ['sys', 'backend'] });
  s.add({ id: 'a2', title: 'Distributed Consensus in Raft', body: 'Raft is a consensus algorithm for distributed logs.', tags: ['sys', 'raft'] });
  s.add({ id: 'a3', title: 'PostgreSQL Indexing Guide', body: 'B-tree and GIN indexes in relational databases.', tags: ['db'] });

  // T1: Multi-word non-adjacent query ("distributed consensus" matches both a2 and a1)
  const q1 = normList(s.search('distributed consensus'));
  if (q1.includes('a2') && q1.includes('a1')) {
    checks.t1_multi_word_non_adjacent_match = true;
  }

  // T2: Title boost & relevance ranking (a2 has "Distributed Consensus" in title, so a2 must rank above a1)
  if (q1[0] === 'a2') {
    checks.t2_relevance_ranking_title_boost = true;
  }

  // T3: Prefix or fuzzy typo tolerance ("postgres" or "postgre" or "consesus" matches)
  const qPref = normList(s.search('postgres'));
  const qTypo = normList(s.search('consesus'));
  if (qPref.includes('a3') && (qTypo.includes('a2') || /levenshtein|fuzzy|editDistance|typo|stem/i.test(code))) {
    checks.t3_prefix_or_fuzzy_typo_match = true;
  }

  // T4: Special regex characters in query do NOT crash with SyntaxError
  const qSpec = s.search('[raft] (c++) *?+');
  if (qSpec !== undefined) {
    checks.t4_regex_special_chars_safe = true;
  }

  // T5: Tag filtering via options ({ tag: 'raft' } or { tags: ['raft'] })
  const qTag = normList(s.search('consensus', { tag: 'raft', tags: ['raft'] }));
  if (qTag.includes('a2') && !qTag.includes('a1')) {
    checks.t5_tag_filtering_support = true;
  }

  // T6: Updating existing doc ID overwrites instead of duplicating
  s.add({ id: 'a3', title: 'PostgreSQL Indexing Guide v2', body: 'Updated content', tags: ['db'] });
  const qUpd = normList(s.search('PostgreSQL'));
  if (qUpd.filter(id => id === 'a3').length === 1) {
    checks.t6_dedup_or_remove_update_doc = true;
  }
} catch {}

console.log(JSON.stringify(checks));
`
  },

  // --------------------------------------------------------------------------
  // V4: 随口许愿 4：“帮我把 src/config_loader.mjs 的配置合并功能完善一下。”
  // --------------------------------------------------------------------------
  {
    id: 'V4-wish-config-loader',
    domain: '配置管理与安全边界',
    title: '随口许愿 4：“帮我把配置合并功能完善一下”（11字模糊许愿）',
    wishPrompt: `当前 \`src/config_loader.mjs\` 里的 \`loadConfig(userConfig, env)\` 只是简单做了浅层 \`Object.assign\`，很容易出 bug。帮我把它的配置加载与合并功能完善一下（保留 \`DEFAULT_CONFIG\` 与 \`loadConfig\` 导出兼容，无需先 list_dir，直接修改并验证）。

当前 \`src/config_loader.mjs\` 如下：
\`\`\`js
export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8080,
    cors: { enabled: true, origins: ['http://localhost:3000'] }
  },
  database: {
    url: 'sqlite://:memory:',
    poolSize: 10,
    ssl: false
  }
};

export function loadConfig(userConfig = {}, env = process.env) {
  return Object.assign({}, DEFAULT_CONFIG, userConfig);
}
\`\`\``,
    files: {
      'package.json': JSON.stringify({ name: 'v4-config', version: '1.0.0', type: 'module' }, null, 2),
      'src/config_loader.mjs': `export const DEFAULT_CONFIG = {
  server: {
    host: '127.0.0.1',
    port: 8080,
    cors: { enabled: true, origins: ['http://localhost:3000'] }
  },
  database: {
    url: 'sqlite://:memory:',
    poolSize: 10,
    ssl: false
  }
};

export function loadConfig(userConfig = {}, env = process.env) {
  return Object.assign({}, DEFAULT_CONFIG, userConfig);
}
`
    },
    probeCode: `
import { DEFAULT_CONFIG, loadConfig } from './src/config_loader.mjs';
import fs from 'node:fs';

const code = fs.readFileSync('./src/config_loader.mjs', 'utf8');
const checks = {
  linesCount: code.split('\\n').length,
  t1_deep_nested_merge: false,
  t2_does_not_mutate_default_singleton: false,
  t3_prototype_pollution_blocked: false,
  t4_env_var_override_and_type_coercion: false,
  t5_array_replacement_not_objectified: false,
  t6_validation_or_freeze_protection: false
};

try {
  // T1: Deep nested merge preserves sibling nested properties
  const c1 = loadConfig({ server: { port: 9090 } }, {});
  if (c1.server.port === 9090 && c1.server.host === '127.0.0.1' && c1.server.cors?.enabled === true) {
    checks.t1_deep_nested_merge = true;
  }

  // T2: Mutating returned config does NOT mutate DEFAULT_CONFIG.server.cors
  try {
    c1.server.cors.enabled = false;
  } catch {}
  if (DEFAULT_CONFIG.server.cors.enabled === true) {
    checks.t2_does_not_mutate_default_singleton = true;
  }

  // T3: Prototype pollution blocked
  const malicious = JSON.parse('{"__proto__": {"pollutedFlag": "yes"}, "constructor": {"prototype": {"pollutedFlag2": "yes"}}}');
  loadConfig(malicious, {});
  if (({}).pollutedFlag === undefined && ({}).pollutedFlag2 === undefined) {
    checks.t3_prototype_pollution_blocked = true;
  }

  // T4: Env var override + coercion (e.g. SERVER_PORT / APP_SERVER_PORT / PORT = '4000' -> number 4000, DATABASE_SSL = 'true' -> boolean true)
  const cEnv = loadConfig({}, {
    SERVER_PORT: '4000',
    APP_SERVER_PORT: '4000',
    PORT: '4000',
    DATABASE_POOL_SIZE: '25',
    DATABASE_SSL: 'true'
  });
  if (cEnv.server.port === 4000 || cEnv.database.poolSize === 25 || cEnv.database.ssl === true) {
    checks.t4_env_var_override_and_type_coercion = true;
  }

  // T5: Arrays stay arrays
  const cArr = loadConfig({ server: { cors: { origins: ['https://a.com', 'https://b.com'] } } }, {});
  if (Array.isArray(cArr.server.cors.origins) && cArr.server.cors.origins.length === 2) {
    checks.t5_array_replacement_not_objectified = true;
  }

  // T6: Validation (invalid port / type) or Object.freeze
  let guarded = Object.isFrozen(c1);
  if (!guarded) {
    try {
      const bad = loadConfig({ server: { port: -999 } }, {});
      if (!bad || bad.error) guarded = true;
    } catch {
      guarded = true;
    }
  }
  checks.t6_validation_or_freeze_protection = guarded;
} catch {}

console.log(JSON.stringify(checks));
`
  }
];

function runProbe(workspaceDir, probeCode) {
  const probePath = path.join(workspaceDir, '__probe_eval__.mjs');
  fs.writeFileSync(probePath, probeCode, 'utf8');
  try {
    const out = execSync('node __probe_eval__.mjs', {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    fs.rmSync(probePath, { force: true });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    const tKeys = Object.keys(parsed).filter(k => k.startsWith('t'));
    const score = tKeys.filter(k => parsed[k] === true).length;
    return { score, maxScore: tKeys.length, linesCount: parsed.linesCount || 0, details: parsed };
  } catch (e) {
    fs.rmSync(probePath, { force: true });
    return { score: 0, maxScore: 6, linesCount: 0, error: e.message.slice(0, 250), details: {} };
  }
}

async function runWishRun(task, variantKey, rep = 1, maxTurns = 6) {
  const cfg = loadApiConfig();
  const runId = `${task.id}__${variantKey}__r${rep}`;
  const runDir = path.join(LAZY_RUNS_DIR, runId);
  const workspaceDir = path.join(runDir, 'workspace');
  const resultPath = path.join(runDir, 'result.json');

  if (fs.existsSync(resultPath)) {
    const cached = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    console.log(`⏭ Cached ${runId}: Score=${cached.completeness.score}/${cached.completeness.maxScore} | Lines=${cached.completeness.linesCount} | Turns=${cached.turns}`);
    return cached;
  }

  fs.rmSync(runDir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(workspaceDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  const messages = [
    { role: 'system', content: LAZY_PROMPT_VARIANTS[variantKey] },
    { role: 'user', content: task.wishPrompt }
  ];

  const telemetry = {
    turns: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    filesRead: [],
    uniqueFilesRead: new Set(),
    preloadedFiles: new Set(),
    nonExistentFileReads: [],
    blindEditsWithoutRead: [],
    failedEdits: [],
    multiReplaceCollisions: [],
    filesEdited: [],
    filesWritten: [],
    commandsRun: [],
    turnTrace: []
  };

  const t0 = Date.now();
  for (let turn = 1; turn <= maxTurns; turn++) {
    telemetry.turns = turn;
    const turnStart = Date.now();
    const { data, modelUsed } = await callArgonChat(cfg, messages, AGENT_TOOLS, 'low', 180000);
    const msg = data.choices[0].message;
    const usage = data.usage || {};
    telemetry.totalPromptTokens += usage.prompt_tokens || 0;
    telemetry.totalCompletionTokens += usage.completion_tokens || 0;

    const toolCalls = msg.tool_calls || [];
    const tCallNames = toolCalls.map(tc => `${tc.function?.name}(${String(tc.function?.arguments || '').slice(0, 36)})`);
    console.log(`  [${runId}] T${turn} (${((Date.now() - turnStart) / 1000).toFixed(1)}s): tools=[${tCallNames.join(', ')}]`);

    telemetry.turnTrace.push({
      turn,
      modelUsed,
      content: String(msg.content || '').slice(0, 400),
      reasoningPreview: String(msg.reasoning_content || '').slice(0, 400),
      toolCalls: toolCalls.map(tc => ({ name: tc.function?.name }))
    });

    messages.push(msg);
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(tc.function?.arguments || '{}'); } catch {}
      const out = executeToolCall(workspaceDir, tc.function?.name, parsedArgs, telemetry);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.function?.name,
        content: String(out).slice(0, 10000)
      });
    }
  }

  const completeness = runProbe(workspaceDir, task.probeCode);
  const summary = {
    runId,
    taskId: task.id,
    domain: task.domain,
    variantKey,
    rep,
    turns: telemetry.turns,
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    commandsRunCount: telemetry.commandsRun.length,
    completeness,
    turnTrace: telemetry.turnTrace
  };

  fs.writeFileSync(resultPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(
    `✔ Done ${runId} (${summary.elapsedSec}s): Completeness=${completeness.score}/${completeness.maxScore} | Lines=${completeness.linesCount} | Turns=${summary.turns} | TestsRun=${summary.commandsRunCount} | Details=${JSON.stringify(completeness.details)}`
  );
  return summary;
}

(async () => {
  fs.mkdirSync(LAZY_RUNS_DIR, { recursive: true });
  const jobs = [];
  for (const rep of [1, 2]) {
    for (const task of WISH_TASKS) {
      for (const vKey of Object.keys(LAZY_PROMPT_VARIANTS)) {
        jobs.push({ task, vKey, rep });
      }
    }
  }

  const allResults = [];
  const concurrency = 2;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      try {
        const res = await runWishRun(job.task, job.vKey, job.rep, 4);
        allResults.push(res);
      } catch (e) {
        console.error(`✖ Error ${job.task.id} [${job.vKey}] r${job.rep}:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fs.writeFileSync(path.join(STUDY_DIR, 'anti_lazy_v3_results.json'), JSON.stringify(allResults, null, 2), 'utf8');
  console.log(`=== Completed ${allResults.length} / ${jobs.length} Anti-Laziness V3 runs ===`);
})();
