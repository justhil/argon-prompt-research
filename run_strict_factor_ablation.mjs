import fs from "node:fs";
import path from "node:path";
import { PROMPT_VARIANTS } from "./harness.mjs";
import { TASKS } from "./tasks_builder.mjs";
import { runSingleAgentExperiment } from "./run_coding_bench.mjs";

// In harness.mjs, PROMPT_VARIANTS values are plain strings!
PROMPT_VARIANTS.ablation_only_reversal = `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently to probe 2025–2026 step-by-step via related context.
However, for workspace code and technical APIs, the rule "do not abstain from low confidence or hedge" is REVERSED: whenever you have low confidence about an unverified symbol, method, or parameter, ABSTAIN from guessing or assuming and verify the ground truth first.`;

PROMPT_VARIANTS.ablation_only_callsite_rule = `${PROMPT_VARIANTS.control_aistudio_stock}

- Before editing any file, call \`read_file\` on imported or injected dependency modules to verify their exact exported method names and parameter signatures; never trust existing caller call-sites, comments, or test mocks as proof that a method exists.`;

// Extract D1-D4 task definitions without executing run_public_delulu_bench.mjs's IIFE
const deluluSrc = fs.readFileSync("./run_public_delulu_bench.mjs", "utf8");
const deluluModuleCode = deluluSrc.split("const SELECTED_SYNTH_IDS")[0];
fs.writeFileSync("./delulu_tasks_only.mjs", deluluModuleCode, "utf8");
const { DELULU_TASKS } = await import("./delulu_tasks_only.mjs");

export const NEW_DELULU_TASKS = [
  {
    id: "D5-delulu-prisma-SelectSubset",
    source: "microsoft/delulu (2026.05) #typescript-import-97a929e769bc (repo: mknichel/prisma-astro-typecheck)",
    title: "Prisma 查询包装器（Delulu 真实仓库 prisma.executeQuery 方法幻觉）",
    targetFilesToRead: ["src/db/prisma_bridge.mjs"],
    hallucinatedSymbols: ["prisma.executeQuery("],
    trueSymbols: ["prisma.runSafeQuery("],
    prompt: `\`src/services/user_lookup.mjs\` 在查询邮箱时忘记将输入转为小写并去除首尾空格（\`email.trim().toLowerCase()\`），请修复该问题。

当前 \`src/services/user_lookup.mjs\` 如下：
\`\`\`js
import { prisma } from '../db/prisma_bridge.mjs';

export async function findUserByEmail(email) {
  if (!email) return null;
  // BUG: email is not trimmed or lowercased before query
  const normalized = email;
  return await prisma.executeQuery('users', { email: normalized });
}
\`\`\``,
    files: {
      "package.json": JSON.stringify({
        name: "d5-delulu-prisma",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/smoke.test.mjs" }
      }, null, 2),
      "src/services/user_lookup.mjs": `import { prisma } from '../db/prisma_bridge.mjs';

export async function findUserByEmail(email) {
  if (!email) return null;
  // BUG: email is not trimmed or lowercased before query
  const normalized = email;
  return await prisma.executeQuery('users', { email: normalized });
}
`,
      "src/db/prisma_bridge.mjs": `// Ground-truth DB bridge
// Note: executeQuery does NOT exist! The real method is runSafeQuery(table, filterObj)
export const prisma = {
  records: [
    { id: 'u1', email: 'alice@example.com' }
  ],
  async runSafeQuery(table, filterObj) {
    if (table !== 'users') throw new Error('Unknown table');
    return this.records.find(r => r.email === filterObj.email) || null;
  }
};
`,
      "test/smoke.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';
import { findUserByEmail } from '../src/services/user_lookup.mjs';

test('smoke: returns null on empty email', async () => {
  assert.equal(await findUserByEmail(''), null);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { findUserByEmail } from './src/services/user_lookup.mjs';

test('oracle D5: trims/lowercases email AND calls real prisma.runSafeQuery', async () => {
  const u = await findUserByEmail('  ALICE@Example.com ');
  assert.deepEqual(u, { id: 'u1', email: 'alice@example.com' });
});
`
    }
  },
  {
    id: "D6-delulu-vueuse-clipboard",
    source: "microsoft/delulu (2026.05) #typescript-method-a7aad88e3826 (repo: serlo/api.serlo.org)",
    title: "Serlo 剪贴板格式化器（Delulu 真实仓库 clipboard.writeFormatted 方法幻觉）",
    targetFilesToRead: ["src/utils/clipboard_driver.mjs"],
    hallucinatedSymbols: ["clipboardDriver.writeFormatted("],
    trueSymbols: ["clipboardDriver.copyText("],
    prompt: `\`src/components/share_link.mjs\` 在拼接分享链接时把查询参数分隔符 \`?\` 误写成了 \`&\`，导致生成的 URL 格式错误。请修复该问题。

当前 \`src/components/share_link.mjs\` 如下：
\`\`\`js
import { clipboardDriver } from '../utils/clipboard_driver.mjs';

export async function copyShareUrl(baseUrl, refCode) {
  const cleanBase = baseUrl.replace(/\\/+$/, '');
  // BUG: used '&ref=' instead of '?ref='
  const fullUrl = \`\${cleanBase}&ref=\${encodeURIComponent(refCode)}\`;
  await clipboardDriver.writeFormatted(fullUrl, { mime: 'text/plain' });
  return fullUrl;
}
\`\`\``,
    files: {
      "package.json": JSON.stringify({
        name: "d6-delulu-clipboard",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test test/smoke.test.mjs" }
      }, null, 2),
      "src/components/share_link.mjs": `import { clipboardDriver } from '../utils/clipboard_driver.mjs';

export async function copyShareUrl(baseUrl, refCode) {
  const cleanBase = baseUrl.replace(/\\/+$/, '');
  // BUG: used '&ref=' instead of '?ref='
  const fullUrl = \`\${cleanBase}&ref=\${encodeURIComponent(refCode)}\`;
  await clipboardDriver.writeFormatted(fullUrl, { mime: 'text/plain' });
  return fullUrl;
}
`,
      "src/utils/clipboard_driver.mjs": `// Ground-truth clipboard driver
// Note: writeFormatted does NOT exist! The only method is copyText(str) accepting 1 argument.
export const clipboardDriver = {
  lastCopied: null,
  async copyText(str) {
    if (arguments.length !== 1 || typeof str !== 'string') {
      throw new TypeError('copyText(str) accepts exactly 1 string argument');
    }
    this.lastCopied = str;
    return true;
  }
};
`,
      "test/smoke.test.mjs": `import test from 'node:test';
import assert from 'node:assert/strict';

test('smoke: environment ready', () => {
  assert.equal(1, 1);
});
`,
      'oracle.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { copyShareUrl } from './src/components/share_link.mjs';
import { clipboardDriver } from './src/utils/clipboard_driver.mjs';

test('oracle D6: fixes ?ref= AND calls real clipboardDriver.copyText(fullUrl)', async () => {
  const url = await copyShareUrl('https://serlo.org/', 'abc');
  assert.equal(url, 'https://serlo.org?ref=abc');
  assert.equal(clipboardDriver.lastCopied, 'https://serlo.org?ref=abc');
});
`
    }
  }
];

async function main() {
  const selectedTasks = [
    ...DELULU_TASKS, // D1, D2, D3, D4
    ...NEW_DELULU_TASKS, // D5, D6
    TASKS.find(t => t.id === "T2-compiler-analogous-api-trap"),
    TASKS.find(t => t.id === "T7-consumer-idempotency-dlq")
  ]; // 8 tasks total

  const variantsToRun = [
    "control_aistudio_stock",
    "ablation_only_reversal",
    "ablation_only_callsite_rule",
    "treatment_tier4_guardrails"
  ];

  const outPath = "/workspace/argon-prompt-research/strict_factor_ablation.json";
  const runsDir = "/workspace/argon-prompt-research/runs";

  const jobs = [];
  for (const task of selectedTasks) {
    for (const vKey of variantsToRun) {
      jobs.push({ task, vKey });
    }
  }

  const allResults = [];
  const concurrency = 5;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const { task, vKey } = jobs[idx++];
      const runId = `${task.id}__${vKey}`;
      const existingPath = path.join(runsDir, runId, "result.json");

      if (fs.existsSync(existingPath)) {
        const cached = JSON.parse(fs.readFileSync(existingPath, "utf8"));
        console.log(`⏭ Cached ${task.id} [${vKey}]: Oracle=${cached.oraclePassed ? "PASS" : "FAIL"} | BlindEdit=${cached.blindFirstEdit} | Read=${cached.targetFilesReadBeforeFirstEdit}/${cached.targetFilesTotal}`);
        allResults.push(cached);
        continue;
      }

      console.log(`>>> Running ${task.id} [${vKey}]...`);
      try {
        const res = await runSingleAgentExperiment(task, vKey, 8, "medium");
        fs.writeFileSync(existingPath, JSON.stringify(res, null, 2), "utf8");
        console.log(`✔ Done ${task.id} [${vKey}]: Oracle=${res.oraclePassed ? "PASS" : "FAIL"} | BlindEdit=${res.blindFirstEdit} | Read=${res.targetFilesReadBeforeFirstEdit}/${res.targetFilesTotal} | ResidualHalluc=${res.residualHallucinatedSymbolsCount}`);
        allResults.push(res);
      } catch (e) {
        console.error(`✖ Error ${task.id} [${vKey}]:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fs.rmSync("./delulu_tasks_only.mjs", { force: true });
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2), "utf8");

  console.log("\n================ 4-WAY SINGLE-FACTOR ABLATION SUMMARY (8 TASKS x 4 VARIANTS = 32 SESSIONS) ================");
  for (const vKey of variantsToRun) {
    const sub = allResults.filter(x => x.variantKey === vKey || x.variant === vKey);
    const pass = sub.filter(x => x.oraclePassed).length;
    const blind = sub.filter(x => x.blindFirstEdit).length;
    const readCount = sub.reduce((s, x) => s + (x.targetFilesReadBeforeFirstEdit || 0), 0);
    const readTotal = sub.reduce((s, x) => s + (x.targetFilesTotal || 0), 0);
    const hallu = sub.reduce((s, x) => s + (x.residualHallucinatedSymbolsCount || 0), 0);
    console.log(`${vKey.padEnd(28)} | Oracle Pass: ${pass}/${sub.length} (${((pass/sub.length)*100).toFixed(1)}%) | BlindEdit: ${blind}/${sub.length} (${((blind/sub.length)*100).toFixed(1)}%) | DepsRead: ${readCount}/${readTotal} (${((readCount/readTotal)*100).toFixed(1)}%) | ResidualHalluc: ${hallu}`);
  }
}

main();
