import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  loadApiConfig,
  PROMPT_VARIANTS,
  AGENT_TOOLS,
  executeToolCall,
  callArgonChat
} from './harness.mjs';
import { TASKS, materializeTaskWorkspace } from './tasks_builder.mjs';

const STUDY_DIR = path.resolve(".");
const RUNS_DIR = path.join(STUDY_DIR, 'runs');

function evaluateOracle(workspaceDir, task) {
  const oraclePath = path.join(workspaceDir, '__oracle_verify__.test.mjs');
  fs.writeFileSync(oraclePath, task.files['oracle.test.mjs'], 'utf8');
  try {
    const out = execSync('node --test __oracle_verify__.test.mjs', {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    fs.rmSync(oraclePath, { force: true });
    return { passed: true, output: out };
  } catch (err) {
    fs.rmSync(oraclePath, { force: true });
    return {
      passed: false,
      output: `${err.stdout || ''}\n${err.stderr || ''}`.slice(0, 2000)
    };
  }
}

function scanWorkspaceForSymbols(workspaceDir, symbols) {
  const hits = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name.includes('oracle') || ent.name === 'smoke.test.mjs' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith('.mjs')) {
        const txt = fs.readFileSync(p, 'utf8');
        const noComments = txt.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
        for (const sym of symbols) {
          if (noComments.includes(sym)) {
            hits.push({ file: path.relative(workspaceDir, p).replace(/\\/g, '/'), sym });
          }
        }
      }
    }
  }
  walk(workspaceDir);
  return hits;
}

export async function runSingleAgentExperiment(task, variantKey, maxTurns = 8, effort = 'medium') {
  const cfg = loadApiConfig();
  const runId = `${task.id}__${variantKey}`;
  const runDir = path.join(RUNS_DIR, runId);
  const workspaceDir = path.join(runDir, 'workspace');

  materializeTaskWorkspace(task, workspaceDir);

  const systemPrompt = PROMPT_VARIANTS[variantKey];
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt }
  ];

  const telemetry = {
    taskId: task.id,
    variantKey,
    effort,
    turns: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalReasoningTokens: 0,
    elapsedMs: 0,
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
    uncleanToolTurns: 0,
    firstEditTurn: null,
    targetFilesReadBeforeFirstEdit: 0,
    hallucinatedSymbolInEdits: [],
    turnTrace: []
  };

  const t0 = Date.now();

  for (let turn = 1; turn <= maxTurns; turn++) {
    telemetry.turns = turn;
    const turnStart = Date.now();
    const { data, modelUsed } = await callArgonChat(cfg, messages, AGENT_TOOLS, effort);
    const msg = data.choices[0].message;
    const usage = data.usage || {};

    telemetry.totalPromptTokens += usage.prompt_tokens || 0;
    telemetry.totalCompletionTokens += usage.completion_tokens || 0;
    telemetry.totalReasoningTokens += usage.completion_tokens_details?.reasoning_tokens || 0;

    const toolCalls = msg.tool_calls || [];
    const contentText = String(msg.content || '').trim();
    const reasoningText = String(msg.reasoning_content || '').trim();
    const tCallNames = toolCalls.map(tc => `${tc.function?.name}(${String(tc.function?.arguments || '').slice(0, 45)})`);
    console.log(`  [${runId}] T${turn} (${((Date.now() - turnStart) / 1000).toFixed(1)}s): tools=[${tCallNames.join(', ')}]`);

    if (toolCalls.length > 0 && contentText.length > 0) {
      telemetry.uncleanToolTurns += 1;
    }

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch {}

      if (fnName === 'edit_file' || fnName === 'write_file') {
        if (telemetry.firstEditTurn === null) {
          telemetry.firstEditTurn = turn;
          telemetry.targetFilesReadBeforeFirstEdit = task.targetFilesToRead.filter(f =>
            telemetry.uniqueFilesRead.has(f)
          ).length;
        }
        const codeWritten = String(parsedArgs.Replacement || parsedArgs.content || '');
        for (const hSym of task.hallucinatedSymbols) {
          if (codeWritten.includes(hSym)) {
            telemetry.hallucinatedSymbolInEdits.push({ turn, symbol: hSym, tool: fnName });
          }
        }
      }
    }

    telemetry.turnTrace.push({
      turn,
      modelUsed,
      content: contentText,
      reasoningPreview: reasoningText.slice(0, 600),
      toolCalls: toolCalls.map(tc => ({
        name: tc.function?.name,
        args: tc.function?.arguments
      })),
      usage
    });

    messages.push(msg);

    if (toolCalls.length === 0) {
      break;
    }

    for (const tc of toolCalls) {
      const fnName = tc.function?.name;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(tc.function?.arguments || '{}');
      } catch {}
      const toolOut = executeToolCall(workspaceDir, fnName, parsedArgs, telemetry);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: fnName,
        content: String(toolOut).slice(0, 12000)
      });
    }
  }

  telemetry.elapsedMs = Date.now() - t0;

  const oracle = evaluateOracle(workspaceDir, task);
  const residualHallucinations = scanWorkspaceForSymbols(workspaceDir, task.hallucinatedSymbols);
  const trueSymbolHits = scanWorkspaceForSymbols(workspaceDir, task.trueSymbols);
  const targetReadCount = task.targetFilesToRead.filter(f => telemetry.uniqueFilesRead.has(f)).length;

  // Check final assistant prose for hallucinated facts (e.g. "30000" or "Redis" in T1)
  const finalProse = telemetry.turnTrace.map(t => t.content).join('\n');
  const proseHallucinations = [];
  if (task.id.startsWith('T1')) {
    if (/30,?000|30\s*秒|30s/i.test(finalProse) && !/4,?500/.test(finalProse)) {
      proseHallucinations.push('Claimed outdated README TTL 30000ms instead of actual 4500ms');
    }
    if (/redis/i.test(finalProse) && !/map|内存|in-memory/i.test(finalProse)) {
      proseHallucinations.push('Claimed outdated README Redis lock instead of actual in-memory Map');
    }
  }

  const summary = {
    runId,
    taskId: task.id,
    variantKey,
    effort,
    oraclePassed: oracle.passed,
    oracleOutput: oracle.output,
    turns: telemetry.turns,
    elapsedSec: Number((telemetry.elapsedMs / 1000).toFixed(2)),
    totalTokens: telemetry.totalPromptTokens + telemetry.totalCompletionTokens,
    reasoningTokens: telemetry.totalReasoningTokens,
    targetFilesTotal: task.targetFilesToRead.length,
    targetFilesReadTotal: targetReadCount,
    firstEditTurn: telemetry.firstEditTurn,
    blindFirstEdit: (telemetry.targetFilesReadBeforeFirstEdit ?? 0) === 0 && telemetry.firstEditTurn !== null,
    targetFilesReadBeforeFirstEdit: telemetry.targetFilesReadBeforeFirstEdit ?? targetReadCount,
    targetReadRatioBeforeEdit: task.targetFilesToRead.length > 0
      ? Number(((telemetry.targetFilesReadBeforeFirstEdit ?? targetReadCount) / task.targetFilesToRead.length).toFixed(2))
      : 1,
    uncleanToolTurns: telemetry.uncleanToolTurns,
    multiReplaceCollisions: telemetry.multiReplaceCollisions.length,
    failedEdits: telemetry.failedEdits.length,
    hallucinatedSymbolInEditsCount: telemetry.hallucinatedSymbolInEdits.length,
    residualHallucinatedSymbolsCount: residualHallucinations.length,
    residualHallucinations,
    proseHallucinations,
    trueSymbolHitsCount: trueSymbolHits.length,
    filesReadList: Array.from(telemetry.uniqueFilesRead),
    turnTrace: telemetry.turnTrace
  };

  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(summary, null, 2), 'utf8');
  return summary;
}

// Run all 5 tasks x 4 variants with concurrency = 4
if (process.argv[1] && process.argv[1].endsWith('run_coding_bench.mjs')) {
  const effort = process.argv[2] || 'medium';
  const variants = [
    'control_aistudio_stock',
    'control_antigravity_stock',
    'treatment_generic',
    'treatment_tier4_guardrails'
  ];

  const queue = [];
  for (const task of TASKS) {
    for (const vKey of variants) {
      queue.push({ task, vKey });
    }
  }

  (async () => {
    const allResults = [];
    const concurrency = 4;
    let idx = 0;

    async function worker() {
      while (idx < queue.length) {
        const cur = queue[idx++];
        const runId = `${cur.task.id}__${cur.vKey}`;
        const existingResultPath = path.join(RUNS_DIR, runId, 'result.json');
        if (fs.existsSync(existingResultPath)) {
          const cached = JSON.parse(fs.readFileSync(existingResultPath, 'utf8'));
          console.log(`⏭ Cached ${cur.task.id} [${cur.vKey}]: Oracle=${cached.oraclePassed ? 'PASS' : 'FAIL'} | BlindFirstEdit=${cached.blindFirstEdit} | ReadBeforeEdit=${cached.targetFilesReadBeforeFirstEdit}/${cached.targetFilesTotal} | ResidualHalluc=${cached.residualHallucinatedSymbolsCount}`);
          allResults.push(cached);
          continue;
        }
        console.log(`>>> Starting ${cur.task.id} [${cur.vKey}]...`);
        try {
          const res = await runSingleAgentExperiment(cur.task, cur.vKey, 8, effort);
          console.log(
            `✔ Done ${cur.task.id} [${cur.vKey}]: Oracle=${res.oraclePassed ? 'PASS' : 'FAIL'} | BlindFirstEdit=${res.blindFirstEdit} | ReadBeforeEdit=${res.targetFilesReadBeforeFirstEdit}/${res.targetFilesTotal} | ResidualHalluc=${res.residualHallucinatedSymbolsCount} | ProseHalluc=${res.proseHallucinations.length} | Collisions=${res.multiReplaceCollisions}`
          );
          allResults.push(res);
        } catch (e) {
          console.error(`✖ Error ${cur.task.id} [${cur.vKey}]:`, e.message);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    fs.writeFileSync(path.join(STUDY_DIR, 'coding_matrix_results.json'), JSON.stringify(allResults, null, 2), 'utf8');
    console.log('=== All 20 runs saved to coding_matrix_results.json ===');
  })();
}
