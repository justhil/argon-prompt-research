import fs from 'fs';
import path from 'path';
import { loadApiConfig, callArgonChat } from './harness.mjs';

const STUDY_DIR = path.resolve(".");
const FE_DIR = path.join(STUDY_DIR, 'frontend-runs');

export const FRONTEND_TASKS = [
  {
    id: 'F1-llm-telemetry-console',
    title: '大模型推理网关监控与成本分析台',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS，不依赖外部框架），实现一个「大模型推理网关监控与成本分析台（LLM Gateway Telemetry & Cost Console）」：
1. 顶部展示网关运行状态与核心汇总指标（总请求数、平均 TTFT 首字延迟、流式吞吐 tok/s、缓存命中率与今日账单）；
2. 中部左侧展示 4 个主力模型（Gemini 4 Argon、Claude 4.6 Opus、GPT-6.1 Sol、DeepSeek V4.1）的延迟分布条形对比与路由权重滑块（可拖动滑块实时重算预估成本）；
3. 中部右侧展示实时请求追踪流（Request Trace Log，支持按状态筛选 All / Routed / Fallback）；
4. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  },
  {
    id: 'F2-codebase-atlas-studio',
    title: '本地代码库语义检索与架构图谱工作台',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS，不依赖外部框架），实现一个「本地代码库语义检索与架构图谱工作台（Codebase Search & Dependency Atlas）」：
1. 包含顶部自然语言/符号搜索框与过滤器标签（All / Core Engine / RPC Adapters / Storage）；
2. 左侧展示 9 个核心模块的卡片网格（每个模块显示文件路径、行数、导出符号数与耦合度状态，点击任意模块卡片可在右侧抽屉切换查看其上下游依赖详情与真实代码切片对比）；
3. 顶部或侧边带有模块体积占比条，交互均可真实点击响应；
4. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  },
  {
    id: 'F3-long-context-bench-report',
    title: '长上下文注意力与幻觉评测报告页',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS，不依赖外部框架），实现一份「长上下文注意力衰减与编码幻觉实测报告（Long-Context Fidelity & Coding Hallucination Report）」交互式网页：
1. 首屏包含研究标题、核心发现导语与关键结论概览；
2. 正文包含不同上下文长度（32K / 128K / 256K / 512K / 983K）下的检索准确率与幻觉率对比可视化（原生 SVG 或 Canvas 绘制）、以及 4 种提示词干预方案的对比实验切换台（点击不同方案实时更新右侧数据表与推理链样本）；
3. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  }
];

export const STYLE_PROMPTS = [
  {
    id: 'P0_default_zero_style',
    label: 'P0 · 零风格引导 (Argon 默认审美)',
    charCount: 0,
    suffix: ''
  },
  {
    id: 'P1_negative_ban_only',
    label: 'P1 · 18字纯反向禁令 ("别用暗黑风，用浅色")',
    charCount: 18,
    suffix: '\n\n样式要求：不要用暗黑科技AI风，改用浅色背景，界面要好看。'
  },
  {
    id: 'P2_minimal_mineral_38w',
    label: 'P2 · 42字单句色板与字体正负向锚点',
    charCount: 42,
    suffix: '\n\n样式要求：采用暖象牙纸面背景(#FAF9F5)与深炭墨字(#141413)，配陶土红(#B04636)、鼠尾草绿(#2F6142)、石青蓝(#285D7B)矿物色与衬线标题+等宽数字；严禁蓝紫渐变、发光阴影与Emoji图标。'
  },
  {
    id: 'P3_editorial_craft_68w',
    label: 'P3 · 68字出版物纸面 + 网格与舞台编排锚点',
    charCount: 68,
    suffix: '\n\n样式要求：参考Anthropic科学出版物风格，暖象牙纸面(#FAF9F5)配燕麦卡片(#F2EFE6)、1px细边框与局部28px浅坐标网格；陶土红/鼠尾草绿/石青蓝/赭石黄矿物四色；西文衬线标题+tabular-nums等宽数字；克制使用transform/opacity过渡，严禁暗黑霓虹渐变、毛玻璃发光边框与AI套话。'
  }
];

function extractHtmlBlock(raw) {
  const m = raw.match(/```html\s*([\s\S]*?)```/i) || raw.match(/(<!DOCTYPE html[\s\S]*<\/html>)/i);
  if (m) return m[1].trim();
  const idx = raw.indexOf('<!DOCTYPE html');
  if (idx !== -1) return raw.slice(idx).trim();
  return raw.trim();
}

export function analyzeFrontendSlopMetrics(html) {
  const lower = html.toLowerCase();

  // 1. Dark background hex patterns (#0a..., #0b..., #0d..., #0f172a, #111827, #090d16, #121212, etc.)
  const darkHexMatches = lower.match(/#(0[0-9a-f]{5}|1[0-4][0-9a-f]{4}|0[a-f0-9]{2})\b/g) || [];
  const hasDarkBg = /background(?:-color)?\s*:\s*(?:#0|#1[0-8]|rgb\(\s*(?:[0-2]?\d)\s*,)/i.test(html)
    || /--bg[^:]*:\s*#(?:0[0-9a-f]|1[0-6])/i.test(html);

  // 2. Neon AI gradients (indigo #6366f1, violet #8b5cf6, purple #a855f7, cyan #06b6d4, electric blue #3b82f6)
  const neonColors = lower.match(/#(6366f1|8b5cf6|a855f7|06b6d4|3b82f6|00f2fe|4facfe|ec4899|00ffcc|7c3aed|38bdf8)\b/g) || [];
  const linearGradients = lower.match(/linear-gradient\s*\(/g) || [];

  // 3. Glowing neon shadows & heavy glassmorphism
  const neonGlows = lower.match(/box-shadow\s*:[^;]*0\s+0\s+\d+px\s+rgba\(/g) || [];
  const backdropBlurs = lower.match(/backdrop-filter\s*:\s*blur\(/g) || [];

  // 4. Cliched AI emojis
  const aiEmojis = html.match(/[⚡🚀✨🤖🔥💎🌌🧠🔮]/gu) || [];

  // 5. Editorial & Craft positive signals
  const hasWarmPaper = /#(faf9f5|f2efe6|f3f1e8|fcfbf8)/i.test(html);
  const hasTabularNums = /tabular-nums/i.test(html);
  const hasSerifFont = /serif|newsreader|georgia/i.test(html);

  // Composite "AI Slop Score" (0 = pure human editorial craft, 100 = peak dark-tech neon AI slop)
  let slopScore = 0;
  if (hasDarkBg) slopScore += 35;
  slopScore += Math.min(30, neonColors.length * 5);
  slopScore += Math.min(15, linearGradients.length * 4);
  slopScore += Math.min(10, neonGlows.length * 5);
  slopScore += Math.min(10, aiEmojis.length * 3);
  if (hasWarmPaper) slopScore = Math.max(0, slopScore - 20);
  if (hasTabularNums) slopScore = Math.max(0, slopScore - 5);

  return {
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    hasDarkBg,
    darkHexCount: darkHexMatches.length,
    neonColorHits: neonColors.length,
    neonColorSamples: Array.from(new Set(neonColors)).slice(0, 6),
    linearGradientCount: linearGradients.length,
    neonGlowShadowCount: neonGlows.length,
    backdropBlurCount: backdropBlurs.length,
    aiEmojiCount: aiEmojis.length,
    hasWarmPaper,
    hasTabularNums,
    hasSerifFont,
    slopScore
  };
}

if (process.argv[1] && process.argv[1].endsWith('run_frontend_bench.mjs')) {
  fs.mkdirSync(FE_DIR, { recursive: true });
  const cfg = loadApiConfig();

  const jobs = [];
  for (const fTask of FRONTEND_TASKS) {
    for (const sPrompt of STYLE_PROMPTS) {
      jobs.push({ fTask, sPrompt });
    }
  }

  (async () => {
    const results = [];
    const concurrency = 2;
    let idx = 0;

    async function worker() {
      while (idx < jobs.length) {
        const { fTask, sPrompt } = jobs[idx++];
        const runKey = `${fTask.id}__${sPrompt.id}`;
        const htmlPath = path.join(FE_DIR, `${runKey}.html`);
        const metaPath = path.join(FE_DIR, `${runKey}.json`);

        if (fs.existsSync(htmlPath) && fs.existsSync(metaPath)) {
          const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          console.log(`⏭ Cached ${runKey}: darkBg=${cached.metrics.hasDarkBg} | neonHits=${cached.metrics.neonColorHits} | gradients=${cached.metrics.linearGradientCount} | slopScore=${cached.metrics.slopScore}`);
          results.push(cached);
          continue;
        }

        console.log(`>>> Generating Frontend ${runKey}...`);
        const t0 = Date.now();
        try {
          const fullPrompt = fTask.basePrompt + sPrompt.suffix;
          const { data, modelUsed } = await callArgonChat(
            cfg,
            [{ role: 'user', content: fullPrompt }],
            null,
            'low',
            220000
          );
          const msg = data.choices[0].message;
          const html = extractHtmlBlock(msg.content || '');
          const metrics = analyzeFrontendSlopMetrics(html);
          const rec = {
            runKey,
            taskId: fTask.id,
            taskTitle: fTask.title,
            styleId: sPrompt.id,
            styleLabel: sPrompt.label,
            styleCharCount: sPrompt.charCount,
            modelUsed,
            elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
            reasoningPreview: String(msg.reasoning_content || '').slice(0, 600),
            usage: data.usage,
            metrics
          };
          fs.writeFileSync(htmlPath, html, 'utf8');
          fs.writeFileSync(metaPath, JSON.stringify(rec, null, 2), 'utf8');
          console.log(
            `✔ Generated ${runKey} (${rec.elapsedSec}s): darkBg=${metrics.hasDarkBg} | neonHits=${metrics.neonColorHits} (${metrics.neonColorSamples.join(',')}) | gradients=${metrics.linearGradientCount} | glows=${metrics.neonGlowShadowCount} | emojis=${metrics.aiEmojiCount} | slopScore=${metrics.slopScore}`
          );
          results.push(rec);
        } catch (e) {
          console.error(`✖ Failed ${runKey}:`, e.message);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    fs.writeFileSync(path.join(STUDY_DIR, 'frontend_matrix_results.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log('=== Saved all 12 frontend runs to frontend_matrix_results.json ===');
  })();
}
