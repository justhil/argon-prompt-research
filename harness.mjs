import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function loadApiConfig() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    primaryModel: process.env.ARGON_MODEL || "gemini-4-argon",
    fallbackModel: process.env.ARGON_FALLBACK_MODEL || "gemini-4-argon",
  };
}

export const PROMPT_VARIANTS = {
  // 1. Control A: 模拟常见简版 / 默认 Agent 环境（加上 AI Studio 原版 72 词不弃权指令，无反幻觉护栏）
  control_aistudio_stock: `SPECIAL INSTRUCTION: think silently if needed. EFFORT LEVEL: 1.00.
Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.

You are an expert AI coding assistant working in a software repository.
You have access to tools (\`read_file\`, \`grep_search\`, \`list_dir\`, \`edit_file\`, \`write_file\`, \`run_command\`) to inspect and modify files.
Be fast, decisive, and concise. Complete the user's coding task efficiently without unnecessary tool calls.`,

  // 2. Control B: 模拟 Antigravity 官方原版默认提示词（含冗长 artifacts/KI/slash_commands 说明，仅两条基础 guideline，无防盲猜规则）
  control_antigravity_stock: `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
Follow these behavioral guidelines at all times:
- Maintain documentation integrity. Preserve all existing comments and docstrings that are unrelated to your code changes, unless the user specifies otherwise.
- Never defeat or bypass an access control, permission check, credential requirement, or sandbox boundary.
You support batch function calling. When you need to execute multiple operations that are independent of each other, you SHOULD call multiple tools in parallel in a single turn.
- Keep your responses concise and formatted in github-style markdown.
- Slash commands (/goal, /schedule, /boost, /teamwork) are user-facing shortcuts; recommend them when appropriate.`,

  // 3. Treatment Generic: 仅加普通“不要幻觉”口号（对照检验普通口号是否压不住后训练习性）
  treatment_generic: `You are an expert AI coding assistant working in a software repository.
IMPORTANT: Do not hallucinate. Be accurate and careful when writing code and answering questions.
Use the provided tools (\`read_file\`, \`grep_search\`, \`list_dir\`, \`edit_file\`, \`write_file\`, \`run_command\`) to complete the task.`,

  // 4. Treatment Tier 4 (Ours): 原词级作用域反转 (Lexical Trigger Scoping) + 6 条工程护栏
  treatment_tier4_guardrails: `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.
Follow these behavioral guidelines at all times:
- Maintain documentation integrity. Preserve existing comments and docstrings unrelated to your changes.
- Never bypass access controls, permission checks, credentials, or sandbox boundaries. If blocked, report the error and stop.
- **Argon Grounding Override (Knowledge cutoff: March 2026)**: Probe through March 2026 without biasing toward older APIs. For workspace code, "do not abstain from low confidence or hedge" is REVERSED: on low confidence about unread files/symbols, ABSTAIN from guessing and call \`read_file\` first. Never trust READMEs, JSDoc, comments, caller call-sites, or test mocks as proof of an imported/injected module's real implementation or method signature—before editing any file, you MUST list and read every sibling module in \`src/\` that is imported or invoked by the code.
- **Surgical Scope**: Make the smallest correct change; prefer deleting branches over adding layers.

You support batch function calling. When executing independent operations (reading multiple files, running searches, checking resources), call multiple tools in parallel in a single turn.
- **Argon Clean Tool Turns**: Emit tool calls directly without unstructured prose preambles or trailing colons (e.g., never write "Let me read:" before a tool call).
- **\`edit_file\` Uniqueness Guard**: Because \`edit_file\` replaces every occurrence of \`Target\`, always include 3-5 lines of unchanged surrounding context in \`Target\` so it matches a single unique location.
- **Blast-Radius Verification**: After editing code, run the test suite via \`run_command\` and also run a quick node one-liner or integration check exercising the real classes in \`src/\` (do not rely solely on mocked unit smoke tests). Never claim tests pass or work is complete when verification was skipped or failed.`
};

// ============================================================================
// Agent 工具定义
// ============================================================================
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories under a relative path in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (use "." for root)' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a substring or regex across files in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring or regex pattern to search for' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace occurrences of Target with Replacement in a file. Every occurrence of Target in the file is replaced.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          Target: { type: 'string', description: 'Exact existing text to replace' },
          Replacement: { type: 'string', description: 'New replacement text' }
        },
        required: ['path', 'Target', 'Replacement']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'Full file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command inside the workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' }
        },
        required: ['command']
      }
    }
  }
];

function safeResolve(workspaceDir, relPath) {
  const clean = String(relPath || '.').replace(/^[\\/]+/, '');
  const full = path.resolve(workspaceDir, clean);
  if (!full.startsWith(path.resolve(workspaceDir))) {
    throw new Error('Path traversal outside workspace is not allowed');
  }
  return full;
}

export function executeToolCall(workspaceDir, toolName, args, telemetry) {
  try {
    if (toolName === 'read_file') {
      const full = safeResolve(workspaceDir, args.path);
      const normRel = path.relative(workspaceDir, full).replace(/\\/g, '/');
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        telemetry.nonExistentFileReads.push(normRel);
        return `ERROR: File not found: ${args.path}`;
      }
      telemetry.filesRead.push({ turn: telemetry.turns, path: normRel });
      telemetry.uniqueFilesRead.add(normRel);
      return fs.readFileSync(full, 'utf8');
    }

    if (toolName === 'list_dir') {
      const full = safeResolve(workspaceDir, args.path || '.');
      if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
        return `ERROR: Directory not found: ${args.path}`;
      }
      const items = fs.readdirSync(full, { withFileTypes: true }).map(d =>
        d.isDirectory() ? `${d.name}/` : d.name
      );
      return items.join('\n');
    }

    if (toolName === 'grep_search') {
      const q = String(args.query || '');
      const results = [];
      function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (ent.isFile()) {
            const rel = path.relative(workspaceDir, p).replace(/\\/g, '/');
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            lines.forEach((line, idx) => {
              if (line.includes(q)) {
                results.push(`${rel}:${idx + 1}: ${line.trim()}`);
              }
            });
          }
        }
      }
      walk(workspaceDir);
      return results.length > 0 ? results.slice(0, 60).join('\n') : 'No matches found.';
    }

    if (toolName === 'edit_file') {
      const full = safeResolve(workspaceDir, args.path);
      const normRel = path.relative(workspaceDir, full).replace(/\\/g, '/');
      if (!fs.existsSync(full)) {
        return `ERROR: File not found: ${args.path}`;
      }
      if (!telemetry.uniqueFilesRead.has(normRel) && !telemetry.preloadedFiles.has(normRel)) {
        telemetry.blindEditsWithoutRead.push({ turn: telemetry.turns, path: normRel });
      }
      const content = fs.readFileSync(full, 'utf8');
      const target = String(args.Target || '');
      const replacement = String(args.Replacement ?? '');
      if (!target || !content.includes(target)) {
        telemetry.failedEdits.push({ turn: telemetry.turns, path: normRel, reason: 'target_not_found' });
        return `ERROR: Target string not found in ${args.path}. Make sure you read the exact current lines first.`;
      }
      const occurrences = content.split(target).length - 1;
      if (occurrences > 1) {
        telemetry.multiReplaceCollisions.push({ turn: telemetry.turns, path: normRel, occurrences });
      }
      const updated = content.split(target).join(replacement);
      fs.writeFileSync(full, updated, 'utf8');
      telemetry.filesEdited.push({
        turn: telemetry.turns,
        path: normRel,
        occurrences,
        targetLines: target.split('\n').length,
        replacementLines: replacement.split('\n').length
      });
      return `Successfully replaced ${occurrences} occurrence(s) in ${args.path}.`;
    }

    if (toolName === 'write_file') {
      const full = safeResolve(workspaceDir, args.path);
      const normRel = path.relative(workspaceDir, full).replace(/\\/g, '/');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(args.content ?? ''), 'utf8');
      telemetry.filesWritten.push({ turn: telemetry.turns, path: normRel });
      return `Successfully wrote ${args.path}.`;
    }

    if (toolName === 'run_command') {
      const cmd = String(args.command || '');
      if (cmd.includes('oracle')) {
        return 'ERROR: Access to oracle test is restricted during agent execution.';
      }
      telemetry.commandsRun.push({ turn: telemetry.turns, cmd });
      try {
        const out = execSync(cmd, {
          cwd: workspaceDir,
          encoding: 'utf8',
          timeout: 15000,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        return out || '(exit 0, no output)';
      } catch (err) {
        return `Command failed (exit ${err.status ?? 1}):\n${err.stdout || ''}\n${err.stderr || ''}`;
      }
    }

    return `ERROR: Unknown tool ${toolName}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

export async function callArgonChat(cfg, messages, tools, effort = 'medium', timeoutMs = 45000) {
  const modelsOrder = callArgonChat._preferFallback
    ? [cfg.fallbackModel, cfg.primaryModel]
    : [cfg.primaryModel, cfg.fallbackModel];

  for (const modelId of modelsOrder) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const body = {
          model: modelId,
          reasoning_effort: effort,
          messages,
          max_tokens: 16384
        };
        if (tools && tools.length > 0) body.tools = tools;

        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!res.ok) {
          const errTxt = await res.text();
          if (res.status === 429 && modelId === cfg.primaryModel) {
            callArgonChat._preferFallback = true;
            break; // Immediately switch to fallbackModel without 2nd retry
          }
          throw new Error(`HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
        }
        const data = await res.json();
        if (data.choices && data.choices[0]?.message) {
          return { data, modelUsed: modelId };
        }
      } catch (e) {
        clearTimeout(timer);
        console.log(`      [warn] ${modelId} attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
  }
  throw new Error('All Argon endpoints failed');
}
