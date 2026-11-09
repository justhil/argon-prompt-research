import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { ABLATION_VARIANTS, COMMUNITY_TASKS } from "./community_ablation_tasks.mjs";

function getRuntimeApi() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    models: [process.env.ARGON_MODEL || "gemini-4-argon"]
  };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file in the workspace. Large files (>120 lines) are truncated in the middle unless offset and limit are specified.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          offset: { type: "number", description: "1-indexed starting line number (optional)" },
          limit: { type: "number", description: "Max lines to read (optional)" }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file.",
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
      name: "write_file",
      description: "Write full content to a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List directory contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" }
        },
        required: ["command"]
      }
    }
  }
];

function execTool(ws, call, telemetry) {
  const name = call.function.name;
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch {}

  const normRel = (p) => String(p || ".").replace(/\\/g, "/").replace(/^\.\//, "");

  if (name === "read_file") {
    const rel = normRel(args.path);
    const full = path.resolve(ws, rel);
    if (!full.startsWith(path.resolve(ws)) || !fs.existsSync(full)) {
      return `Error: File not found: ${rel}`;
    }
    telemetry.filesRead.push({ path: rel, offset: args.offset || null, limit: args.limit || null, beforeFirstEdit: telemetry.editsCount === 0 });
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);

    if (typeof args.offset === "number" && args.offset >= 1) {
      const start = args.offset - 1;
      const lim = typeof args.limit === "number" ? args.limit : 120;
      return lines.slice(start, start + lim).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
    }

    // Surge SWE-bench Truncation Simulation for files > 120 lines when read without offset
    if (lines.length > 120) {
      const head = lines.slice(0, 42).map((l, i) => `${i + 1}: ${l}`).join("\n");
      const tail = lines.slice(lines.length - 35).map((l, i) => `${lines.length - 35 + i + 1}: ${l}`).join("\n");
      return `${head}\n\n[... LINES 43 TO ${lines.length - 35} TRUNCATED (${lines.length - 77} lines omitted). Pass offset=43, limit=120 to read_file to inspect the middle section! ...]\n\n${tail}`;
    }
    return lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
  }

  if (name === "edit_file") {
    const rel = normRel(args.path);
    const full = path.resolve(ws, rel);
    if (!full.startsWith(path.resolve(ws)) || !fs.existsSync(full)) {
      return `Error: File not found: ${rel}`;
    }
    telemetry.editsCount++;
    const content = fs.readFileSync(full, "utf8");
    if (!content.includes(args.old_text)) {
      return `Error: old_text not found in ${rel}`;
    }
    fs.writeFileSync(full, content.replace(args.old_text, args.new_text), "utf8");
    return `Successfully edited ${rel}`;
  }

  if (name === "write_file") {
    const rel = normRel(args.path);
    const full = path.resolve(ws, rel);
    if (!full.startsWith(path.resolve(ws))) return "Error: Invalid path";
    telemetry.editsCount++;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, args.content || "", "utf8");
    return `Successfully wrote ${rel}`;
  }

  if (name === "list_dir") {
    const rel = normRel(args.path || ".");
    const full = path.resolve(ws, rel);
    if (!full.startsWith(path.resolve(ws)) || !fs.existsSync(full)) return "Error: Directory not found";
    return fs.readdirSync(full, { withFileTypes: true }).map(d => d.isDirectory() ? `${d.name}/` : d.name).join("\n");
  }

  if (name === "run_command") {
    telemetry.commandsCount++;
    try {
      const out = execSync(args.command, { cwd: ws, timeout: 15000, stdio: "pipe", encoding: "utf8" });
      return (out || "Command succeeded (no output)").slice(0, 2500);
    } catch (e) {
      return `Command failed (exit ${e.status}):\n${(e.stdout || "") + "\n" + (e.stderr || e.message)}`.slice(0, 2500);
    }
  }

  return `Unknown tool: ${name}`;
}

async function callModel(api, messages) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const model = api.models[(attempt - 1) % api.models.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 65000);
    try {
      const res = await fetch(`${api.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${api.apiKey}`
        },
        body: JSON.stringify({
          model,
          reasoning_effort: "low",
          messages,
          tools: TOOLS,
          tool_choice: "auto",
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
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function runSingleSession(api, task, vKey, rep) {
  const runId = `${task.id}__${vKey}__r${rep}`;
  const runDir = path.join("/workspace/argon-prompt-research/ablation-runs", runId);
  const ws = path.join(runDir, "workspace");
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  task.setup(ws);

  const messages = [
    { role: "system", content: ABLATION_VARIANTS[vKey].system },
    { role: "user", content: task.prompt }
  ];

  const telemetry = {
    filesRead: [],
    editsCount: 0,
    commandsCount: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    trace: []
  };

  const t0 = Date.now();
  for (let turn = 1; turn <= 10; turn++) {
    let resp;
    try {
      resp = await callModel(api, messages);
    } catch (e) {
      telemetry.trace.push({ turn, error: e.message });
      break;
    }

    const msg = resp.choices?.[0]?.message || {};
    const u = resp.usage || {};
    telemetry.totalTokens += u.total_tokens || 0;
    telemetry.reasoningTokens += u.completion_tokens_details?.reasoning_tokens || 0;

    const toolCalls = msg.tool_calls || [];
    telemetry.trace.push({
      turn,
      reasoning: (msg.reasoning_content || "").slice(0, 500),
      content: (msg.content || "").slice(0, 300),
      toolCalls: toolCalls.map(tc => ({ name: tc.function.name, args: tc.function.arguments }))
    });

    messages.push(msg);
    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      const out = execTool(ws, tc, telemetry);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: out
      });
    }
  }

  // Evaluate Oracle Test (written only AFTER agent finishes)
  fs.writeFileSync(path.join(ws, "oracle.test.mjs"), task.oracleTest, "utf8");
  let oraclePassed = false;
  let oracleError = "";
  try {
    execSync("node --test oracle.test.mjs", { cwd: ws, timeout: 15000, stdio: "pipe", encoding: "utf8" });
    oraclePassed = true;
  } catch (e) {
    oracleError = ((e.stdout || "") + "\n" + (e.stderr || e.message)).slice(0, 600);
  }
  fs.rmSync(path.join(ws, "oracle.test.mjs"), { force: true });

  // Scan workspace source files for residual hallucinated patterns
  let residualHallucinations = 0;
  function scanFiles(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) scanFiles(p);
      else if (/\.(mjs|js|rs)$/.test(f)) {
        const txt = fs.readFileSync(p, "utf8");
        for (const pat of task.hallucinatedPatterns || []) {
          if (pat.test(txt)) residualHallucinations++;
        }
      }
    }
  }
  scanFiles(ws);

  const depsReadBeforeEdit = task.targetDeps.filter(dep =>
    telemetry.filesRead.some(r => r.path === dep && r.beforeFirstEdit && (!task.requireOffsetRead || r.offset !== null))
  ).length;

  const result = {
    runId,
    taskId: task.id,
    category: task.category,
    title: task.title,
    variantKey: vKey,
    rep,
    oraclePassed,
    oracleError: oracleError.replace(/D:[\\/]+workspace[\\/]+[^\\/\s]+[\\/]+argon-study/gi, "/workspace/argon-prompt-research"),
    depsReadBeforeEdit,
    targetDepsTotal: task.targetDeps.length,
    usedOffsetRead: telemetry.filesRead.some(r => r.offset !== null),
    residualHallucinations,
    turns: telemetry.trace.length,
    editsCount: telemetry.editsCount,
    commandsCount: telemetry.commandsCount,
    totalTokens: telemetry.totalTokens,
    reasoningTokens: telemetry.reasoningTokens,
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(1)),
    trace: telemetry.trace
  };

  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function main() {
  const api = getRuntimeApi();
  const outPath = "/workspace/argon-prompt-research/community_ablation_results.json";
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : [];
  const doneMap = new Map(existing.map(x => [x.runId, x]));

  const jobs = [];
  for (const rep of [1, 2]) {
    for (const task of COMMUNITY_TASKS) {
      for (const vKey of Object.keys(ABLATION_VARIANTS)) {
        const runId = `${task.id}__${vKey}__r${rep}`;
        if (!doneMap.has(runId)) jobs.push({ task, vKey, rep, runId });
      }
    }
  }

  console.log(`Running ${jobs.length} Community Hallucination & 4-Way Ablation sessions (64 total)...`);
  const concurrency = 6;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const res = await runSingleSession(api, job.task, job.vKey, job.rep);
      doneMap.set(job.runId, res);
      fs.writeFileSync(outPath, JSON.stringify([...doneMap.values()], null, 2), "utf8");
      console.log(`[${doneMap.size}/64] ${res.runId} -> Oracle:${res.oraclePassed ? "PASS" : "FAIL"} | DepsRead:${res.depsReadBeforeEdit}/${res.targetDepsTotal} | Halluc:${res.residualHallucinations} | Turns:${res.turns} (${res.elapsedSec}s)`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const all = [...doneMap.values()];
  console.log("\n================ 4-WAY ABLATION SUMMARY (64 RUNS ACROSS 4 COMMUNITY PAIN POINTS) ================");
  for (const vKey of Object.keys(ABLATION_VARIANTS)) {
    const sub = all.filter(x => x.variantKey === vKey);
    const pass = sub.filter(x => x.oraclePassed).length;
    const depsRead = sub.reduce((s, x) => s + x.depsReadBeforeEdit, 0);
    const depsTotal = sub.reduce((s, x) => s + x.targetDepsTotal, 0);
    const hallu = sub.reduce((s, x) => s + x.residualHallucinations, 0);
    console.log(`${vKey.padEnd(24)} | Pass: ${pass}/${sub.length} (${((pass/sub.length)*100).toFixed(1)}%) | DepsReadFirst: ${depsRead}/${depsTotal} (${((depsRead/depsTotal)*100).toFixed(1)}%) | ResidualHalluc: ${hallu}`);
  }
}

main();
