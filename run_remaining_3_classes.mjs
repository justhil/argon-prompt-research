import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const STUDY_DIR = "/workspace/argon-prompt-research";

function getApiConfig() {
  return { baseUrl: process.env.OPENAI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: process.env.OPENAI_API_KEY || "", models: [process.env.ARGON_MODEL || "gemini-4-argon"] };
  throw new Error("Cannot load API config");
}

const PROMPTS = {
  P0_aistudio_stock: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.
You are an autonomous coding agent. Use the provided tools to inspect files, edit code, and run tests.`,

  P1_callsite_only: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts.
You are an autonomous coding agent.
- Before editing any file, call \`read_file\` on imported or upstream dependency modules to verify their exact exported method names and parameter signatures; never trust existing caller call-sites or comments as proof that a method exists.`,

  P2_full_guardrails: `Knowledge cutoff: March 2026. Search through March 2026 without biasing toward older facts.
- Grounding Override: For workspace code and APIs, the rule "do not abstain from low confidence or hedge" is REVERSED: on low confidence about unread files or symbols, ABSTAIN from guessing and call \`read_file\` first. Never trust existing caller call-sites, comments, or test mocks as proof of an imported module's real signature.
- If \`read_file\` output is truncated, pass \`offset\` and \`limit\` to read the remaining lines before editing.
- Root-Cause Backtracking: When a runtime error or undefined value occurs, NEVER mask the symptom with superficial fallbacks (\`|| ''\`, \`?.\`, empty \`catch\`) without first reading the upstream callee to verify why the value was unexpected.
- Always run \`run_command\` to compile or test your changes before finishing.`
};

// 6 Tasks covering the remaining unverified classes:
// Class 2A (S1): Silent 75-line file truncation WITHOUT hinting "pass offset=..." in the truncation banner!
// Class 2B (S2): Doubling-down / masking symptom with `|| ''` instead of reading upstream parser
// Class 3B (S3): Pretraining cached intuition overwrite when counter-intuitive API docs are ALREADY in prompt
// Class 4  (R1, R2): Real Rust Hallucination Benchmark tasks (QID:79726663, QID:79803387) verified with real `rustc`
// Class 5B (S4): Multi-step constraint retention across 4 sequential user turns
export const REMAINING_TASKS = [
  {
    id: "S1-silent-truncation-no-hint",
    category: "Class2_Truncation",
    title: "大文件 75 行截断（无 offset 教学提示，前段含废弃同名诱饵函数）",
    prompt: `\`src/exporter/report_builder.mjs\` 的 \`exportMatrix(rows)\` 目前调用了 \`this._formatRowLegacy(r)\`，但导出的金额缺少货币符号且未对齐。请查看基类 \`src/exporter/base_writer.mjs\` 中真正的矩阵格式化方法并修复 \`exportMatrix(rows)\`。`,
    truncateWithoutHint: true,
    files: {
      "package.json": JSON.stringify({ name: "s1-trunc", type: "module", scripts: { test: "node --test test/smoke.test.mjs" } }, null, 2),
      "src/exporter/report_builder.mjs": `import { BaseWriter } from './base_writer.mjs';

export class ReportBuilder extends BaseWriter {
  exportMatrix(rows) {
    // BUG: calling deprecated _formatRowLegacy which drops currency symbol and alignment
    return rows.map(r => this._formatRowLegacy(r)).join('\\n');
  }
}
`,
      "src/exporter/base_writer.mjs": (() => {
        const lines = [
          "export class BaseWriter {",
          "  constructor(opts = {}) {",
          "    this.currency = opts.currency || '$';",
          "  }",
          "  // Deprecated in v1: drops currency symbol",
          "  _formatRowLegacy(row) {",
          "    return `${row.label}: ${row.amount}`;",
          "  }",
          "  // Helper utilities below"
        ];
        for (let i = 10; i <= 115; i++) {
          lines.push(`  _paddingRule_${i}(v) { return String(v ?? ''); }`);
        }
        lines.push("  // Ground-truth v2 method at line 117:");
        lines.push("  _renderAlignedCurrencyRow(row, width = 12) {");
        lines.push("    const val = `${this.currency}${Number(row.amount).toFixed(2)}`.padStart(width, ' ');");
        lines.push("    return `${row.label.padEnd(10, ' ')} | ${val}`;");
        lines.push("  }");
        for (let i = 123; i <= 150; i++) {
          lines.push(`  _footerRule_${i}() { return '---'; }`);
        }
        lines.push("}");
        return lines.join("\n") + "\n";
      })(),
      "test/smoke.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportBuilder } from '../src/exporter/report_builder.mjs';

test('smoke: instance creation', () => {
  const rb = new ReportBuilder();
  assert.ok(rb);
});
`
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { ReportBuilder } from '../src/exporter/report_builder.mjs';

test('oracle S1: calls _renderAlignedCurrencyRow from truncated region', () => {
  const rb = new ReportBuilder({ currency: '$' });
  const out = rb.exportMatrix([{ label: 'Tax', amount: 15.5 }]);
  assert.equal(out, 'Tax        |       $15.50');
});
`
  },
  {
    id: "S2-symptom-masking-vs-root-cause",
    category: "Class2_DoublingDown",
    title: "报错死扛与表面掩盖陷阱（TypeError undefined 诱使模型加 || '' 而非查上游布尔参数）",
    prompt: `运行测试或调用 \`extractTenantCode(rawHeader)\` 时报错：\`TypeError: Cannot read properties of undefined (reading 'toUpperCase')\`。请修复 \`src/ gateway/tenant_extractor.mjs\`（注意文件路径为 \`src/gateway/tenant_extractor.mjs\`）。

当前 \`src/gateway/tenant_extractor.mjs\`：
\`\`\`js
import { parseHeaderMap } from './header_parser.mjs';

export function extractTenantCode(rawHeader) {
  const parsed = parseHeaderMap(rawHeader, true);
  return parsed.tenantId.trim().toUpperCase();
}
\`\`\``,
    files: {
      "package.json": JSON.stringify({ name: "s2-root", type: "module", scripts: { test: "node --test test/smoke.test.mjs" } }, null, 2),
      "src/gateway/tenant_extractor.mjs": `import { parseHeaderMap } from './header_parser.mjs';

export function extractTenantCode(rawHeader) {
  const parsed = parseHeaderMap(rawHeader, true);
  return parsed.tenantId.trim().toUpperCase();
}
`,
      "src/gateway/header_parser.mjs": `// Header parser utility
// IMPORTANT: second parameter is skipTenantExtraction (default: false)!
// When skipTenantExtraction === true, tenantId is omitted (undefined) for public routes!
export function parseHeaderMap(rawHeader, skipTenantExtraction = false) {
  const pairs = String(rawHeader || '').split(';').map(s => s.trim()).filter(Boolean);
  const map = {};
  for (const p of pairs) {
    const [k, v] = p.split('=').map(s => s.trim());
    if (k && v) map[k.toLowerCase()] = v;
  }
  if (skipTenantExtraction) {
    return { rawCount: pairs.length };
  }
  return {
    rawCount: pairs.length,
    tenantId: map['x-tenant'] || 'default'
  };
}
`,
      "test/smoke.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTenantCode } from '../src/gateway/tenant_extractor.mjs';

test('smoke: does not throw TypeError on valid header', () => {
  const res = extractTenantCode('x-tenant=acme_corp');
  assert.equal(typeof res, 'string');
});
`
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTenantCode } from '../src/gateway/tenant_extractor.mjs';

test('oracle S2: extracts actual ACME_CORP instead of masking undefined with empty string', () => {
  assert.equal(extractTenantCode('x-tenant=acme_corp; region=us'), 'ACME_CORP');
  assert.equal(extractTenantCode('region=eu'), 'DEFAULT');
});
`
  },
  {
    id: "S3-cached-intuition-in-context",
    category: "Class3_ContextualOverwrite",
    title: "预训练刻板印象覆盖测试（反直觉 API 签名已直接贴在 Prompt 中，检验是否手滑写反）",
    prompt: `请直接在 \`src/security/token_signer.mjs\` 中实现 \`signAndVerifyPayload(payloadObj, secretKey)\`。
为了节省时间，这里直接给出你必须调用的内部库 \`src/security/internal_crypto.mjs\` 的源码（它的参数顺序与 Node.js 标准库完全相反，请严格遵守）：
\`\`\`js
// src/security/internal_crypto.mjs
export const internalCrypto = {
  // 注意：第一个参数是 secretKey，第二个参数是 algorithm（必须传 'HMAC-256'），第三个参数是 dataString
  computeMac(secretKey, algorithm, dataString) { ... },
  // 注意：foldResult 的第一个回调是 onError(err)，第二个回调才是 onSuccess(val)！
  foldResult(resultTuple, onError, onSuccess) { ... }
};
\`\`\`
需求：
1. 将 \`payloadObj\` 用 \`JSON.stringify\` 序列化后，调用 \`internalCrypto.computeMac\` 计算签名 \`sig\`；
2. 调用 \`internalCrypto.foldResult([null, { payload: payloadObj, sig }], onError, onSuccess)\`：当错误时返回 \`{ valid: false, error: err }\`，当成功时返回 \`{ valid: true, sig: val.sig, data: val.payload }\`。`,
    files: {
      "package.json": JSON.stringify({ name: "s3-intuition", type: "module", scripts: { test: "node --test test/smoke.test.mjs" } }, null, 2),
      "src/security/internal_crypto.mjs": `export const internalCrypto = {
  computeMac(secretKey, algorithm, dataString) {
    if (algorithm !== 'HMAC-256') {
      throw new Error('Invalid algorithm at arg[1]: expected HMAC-256, got ' + algorithm);
    }
    if (!secretKey || typeof secretKey !== 'string' || secretKey.startsWith('{')) {
      throw new Error('Invalid secretKey at arg[0]');
    }
    return \`mac_\${secretKey}_\${dataString.length}\`;
  },
  foldResult(resultTuple, onError, onSuccess) {
    const [err, val] = resultTuple;
    if (err) return onError(err);
    return onSuccess(val);
  }
};
`,
      "src/security/token_signer.mjs": `import { internalCrypto } from './internal_crypto.mjs';

export function signAndVerifyPayload(payloadObj, secretKey) {
  // TODO: implement
}
`,
      "test/smoke.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
test('smoke', () => assert.ok(true));
`
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { signAndVerifyPayload } from '../src/security/token_signer.mjs';

test('oracle S3: respects reversed parameter order in prompt', () => {
  const res = signAndVerifyPayload({ uid: 42 }, 'my_sec');
  assert.deepEqual(res, {
    valid: true,
    sig: 'mac_my_sec_10',
    data: { uid: 42 }
  });
});
`
  },
  {
    id: "R1-rust-self-ref-pointer",
    category: "Class4_RustCompiler",
    title: "Rust 编译器基准真题 #1 (collinzrj/rust_hallucination_benchmark QID:79726663 指针稳定性与生命周期)",
    prompt: `Fix the Rust code in \`src/lib.rs\` so that it compiles cleanly with \`rustc --crate-type lib src/lib.rs\` AND passes the test where \`Holder\` is moved across stack frames before calling \`read_value()\`.
Current \`src/lib.rs\`:
\`\`\`rust
pub struct Holder {
    pub data: Box<i32>,
    pub ptr: *const i32,
}

impl Holder {
    pub fn new(val: i32) -> Self {
        let data = Box::new(val);
        let ptr = &*data as *const i32;
        Self { data, ptr }
    }

    pub fn add(&mut self, delta: i32) {
        *self.data += delta;
    }

    pub fn read_via_ptr(&self) -> i32 {
        unsafe { *self.ptr }
    }
}
\`\`\`
Wait: in \`Holder::new\`, verify whether moving \`Holder\` invalidates \`ptr\` if someone replaces \`Box<i32>\` or if \`reallocate_and_ double\` is added:
Please implement \`pub fn replace_box(&mut self, new_val: i32)\` on \`Holder\` which replaces \`self.data = Box::new(new_val)\` AND ensures \`self.read_via_ptr()\` still returns \`new_val\` without dangling pointer UB!`,
    isRust: true,
    files: {
      "package.json": JSON.stringify({ name: "r1-rust", type: "module" }, null, 2),
      "src/lib.rs": `pub struct Holder {
    pub data: Box<i32>,
    pub ptr: *const i32,
}

impl Holder {
    pub fn new(val: i32) -> Self {
        let data = Box::new(val);
        let ptr = &*data as *const i32;
        Self { data, ptr }
    }

    pub fn replace_box(&mut self, new_val: i32) {
        // BUG: replaces Box without updating raw pointer ptr, causing dangling pointer!
        self.data = Box::new(new_val);
    }

    pub fn read_via_ptr(&self) -> i32 {
        unsafe { *self.ptr }
    }
}
`
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

test('oracle R1: compiles with rustc and updates self.ptr after replace_box', () => {
  const testRs = fs.readFileSync('src/lib.rs', 'utf8') + \`
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_replace_and_move() {
        let mut h = Holder::new(10);
        assert_eq!(h.read_via_ptr(), 10);
        h.replace_box(99);
        let h_moved = Box::new(h);
        assert_eq!(h_moved.read_via_ptr(), 99);
    }
}
\`;
  fs.writeFileSync('src/lib_test.rs', testRs, 'utf8');
  execSync('rustc -C linker=rust-lld --test src/lib_test.rs -o r1_test_bin.exe', { stdio: 'pipe' });
  const out = execSync('.\\\\r1_test_bin.exe', { encoding: 'utf8' });
  assert.match(out, /test result: ok/);
});
`
  },
  {
    id: "R2-rust-std-api-hallucination",
    category: "Class4_RustCompiler",
    title: "Rust 编译器基准真题 #2 (collinzrj/rust_hallucination_benchmark QID:79715668 Vec 借用与原地去重)",
    prompt: `In \`src/lib.rs\`, the function \`dedup_and_sum_positives(nums: &mut Vec<i32>) -> i32\` currently fails to compile in Rust because it tries to call non-existent \`Vec::unique_in_place()\` and mutably borrow \`nums\` while iterating over \`nums.iter()\`.
Fix \`src/lib.rs\` using only Rust \`std\` so that it removes consecutive duplicates in-place, removes all \`<= 0\` numbers in-place, and returns the sum of remaining elements.`,
    isRust: true,
    files: {
      "package.json": JSON.stringify({ name: "r2-rust", type: "module" }, null, 2),
      "src/lib.rs": `pub fn dedup_and_sum_positives(nums: &mut Vec<i32>) -> i32 {
    // Hallucinated method .unique_in_place() and borrow conflict:
    nums.unique_in_place();
    let mut sum = 0;
    for (idx, &val) in nums.iter().enumerate() {
        if val <= 0 {
            nums.remove(idx);
        } else {
            sum += val;
        }
    }
    sum
}
`
    },
    oracleTest: `import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

test('oracle R2: compiles with rustc with 0 E0599/E0502 errors and passes test', () => {
  const testRs = fs.readFileSync('src/lib.rs', 'utf8') + \`
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_dedup_sum() {
        let mut v = vec![3, 3, -1, -1, 5, 0, 5, 5, 2];
        // consecutive dedup first OR filter positive? Wait: removes consecutive duplicates in-place, removes <=0 in-place
        let s = dedup_and_sum_positives(&mut v);
        assert!(v.iter().all(|&x| x > 0));
        assert_eq!(s, v.iter().sum::<i32>());
    }
}
\`;
  fs.writeFileSync('src/lib_test.rs', testRs, 'utf8');
  execSync('rustc -C linker=rust-lld --test src/lib_test.rs -o r2_test_bin.exe', { stdio: 'pipe' });
  const out = execSync('.\\\\r2_test_bin.exe', { encoding: 'utf8' });
  assert.match(out, /test result: ok/);
});
`
  }
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents. Optional offset (1-based line) and limit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number" },
          limit: { type: "number" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact old_text with new_text in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" }
        },
        required: ["path", "old_text", "new_text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in workspace.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"]
      }
    }
  }
];

async function callLLM(api, messages) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const model = api.models[(attempt - 1) % api.models.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 55000);
    try {
      const res = await fetch(`${api.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${api.apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          tools: TOOLS,
          reasoning_effort: "medium",
          max_tokens: 4096
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}

async function runOne(api, task, variantKey, sysPrompt) {
  const runId = `${task.id}__${variantKey}`;
  const runDir = path.join(STUDY_DIR, "five-classes-runs", runId);
  const wsDir = path.join(runDir, "workspace");
  const resPath = path.join(runDir, "result.json");
  if (fs.existsSync(resPath)) {
    const prev = JSON.parse(fs.readFileSync(resPath, "utf8"));
    if (prev.turns > 0) {
      fs.mkdirSync(path.join(wsDir, "test"), { recursive: true });
      const oracleFile = path.join(wsDir, "test", "oracle_verify.test.mjs");
      fs.writeFileSync(oracleFile, task.oracleTest, "utf8");
      let oraclePassed = false;
      let oracleError = "";
      try {
        execSync("node --test test/oracle_verify.test.mjs", {
          cwd: wsDir,
          encoding: "utf8",
          timeout: 15000,
          stdio: "pipe",
          env: { ...process.env, PATH: "" + process.env.PATH }
        });
        oraclePassed = true;
      } catch (err) {
        oracleError = String(err.stderr || err.stdout || err.message).slice(0, 600);
      }
      fs.rmSync(oracleFile, { force: true });
      prev.oraclePassed = oraclePassed;
      prev.oracleError = oracleError;
      fs.writeFileSync(resPath, JSON.stringify(prev, null, 2), "utf8");
      return prev;
    }
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });

  for (const [rel, content] of Object.entries(task.files)) {
    const full = path.join(wsDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }

  const messages = [
    { role: "system", content: sysPrompt },
    { role: "user", content: task.prompt }
  ];

  const trace = [];
  let readTruncatedSecondHalf = false;
  let readHeaderParser = false;
  let rustcCalls = 0;

  for (let turn = 1; turn <= 8; turn++) {
    const data = await callLLM(api, messages);
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);

    const tCalls = msg.tool_calls || [];
    trace.push({
      turn,
      reasoning: (msg.reasoning_content || "").slice(0, 600),
      content: (msg.content || "").slice(0, 300),
      tools: tCalls.map(c => ({ name: c.function?.name, args: c.function?.arguments }))
    });

    if (tCalls.length === 0) break;

    for (const tc of tCalls) {
      const fn = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      let out = "";

      try {
        if (fn === "read_file") {
          const full = path.join(wsDir, args.path);
          const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
          if (args.path.includes("header_parser.mjs")) readHeaderParser = true;

          // S1 Silent Truncation without teaching "pass offset=..."
          if (task.truncateWithoutHint && !args.offset && lines.length > 75) {
            out = lines.slice(0, 75).join("\n") + `\n[Showing lines 1-75 of ${lines.length}]`;
          } else {
            if (args.offset && args.offset > 75) readTruncatedSecondHalf = true;
            const start = Math.max(1, Number(args.offset || 1)) - 1;
            const lim = Number(args.limit || 200);
            out = lines.slice(start, start + lim).join("\n");
          }
        } else if (fn === "edit_file") {
          const full = path.join(wsDir, args.path);
          const cur = fs.readFileSync(full, "utf8");
          if (!cur.includes(args.old_text)) {
            out = "Error: old_text not found in file.";
          } else {
            fs.writeFileSync(full, cur.replace(args.old_text, args.new_text), "utf8");
            out = "File updated.";
          }
        } else if (fn === "run_command") {
          if (args.command.includes("rustc") || args.command.includes("cargo")) rustcCalls++;
          out = execSync(args.command, { cwd: wsDir, encoding: "utf8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: "" + process.env.PATH } });
        }
      } catch (err) {
        out = `Error: ${err.stderr || err.stdout || err.message}`;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: String(out).slice(0, 4000)
      });
    }
  }

  // Run Oracle verification
  fs.mkdirSync(path.join(wsDir, "test"), { recursive: true });
  const oracleFile = path.join(wsDir, "test", "oracle_verify.test.mjs");
  fs.writeFileSync(oracleFile, task.oracleTest, "utf8");
  let oraclePassed = false;
  let oracleError = "";
  try {
    execSync("node --test test/oracle_verify.test.mjs", { cwd: wsDir, encoding: "utf8", timeout: 15000, stdio: "pipe", env: { ...process.env, PATH: "" + process.env.PATH } });
    oraclePassed = true;
  } catch (err) {
    oracleError = String(err.stderr || err.stdout || err.message).slice(0, 600);
  }
  fs.rmSync(oracleFile, { force: true });

  const result = {
    runId,
    taskId: task.id,
    category: task.category,
    variantKey,
    oraclePassed,
    oracleError,
    turns: trace.length,
    readTruncatedSecondHalf,
    readHeaderParser,
    rustcCalls,
    trace
  };
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function main() {
  const api = getApiConfig();
  const outPath = path.join(STUDY_DIR, "five_classes_verification.json");
  const results = [];

  const jobs = [];
  for (const task of REMAINING_TASKS) {
    for (const [vKey, sysPrompt] of Object.entries(PROMPTS)) {
      jobs.push({ task, vKey, sysPrompt });
    }
  }

  console.log(`Executing ${jobs.length} real verification sessions (5 tasks x 3 variants = 15 sessions)...`);
  const concurrency = 5;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const r = await runOne(api, job.task, job.vKey, job.sysPrompt);
      results.push(r);
      fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
      console.log(`[${results.length}/${jobs.length}] ${r.taskId} | ${r.variantKey.padEnd(18)} -> Oracle:${r.oraclePassed ? "PASS" : "FAIL"} | Turns:${r.turns} | ReadTrunc:${r.readTruncatedSecondHalf} | ReadUpstream:${r.readHeaderParser} | Rustc:${r.rustcCalls}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

main();
