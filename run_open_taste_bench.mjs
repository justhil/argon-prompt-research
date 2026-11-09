import fs from 'fs';
import path from 'path';
import { loadApiConfig, callArgonChat } from './harness.mjs';
import { analyzeFrontendSlopMetrics } from './run_frontend_bench.mjs';

const STUDY_DIR = path.resolve(".");
const OPEN_FE_DIR = path.join(STUDY_DIR, 'open-taste-runs');

export const DIVERSE_TASKS = [
  {
    id: 'W1-synth-sequencer',
    title: '模块化步进音序器与合成器控制面板 (Tactile Audio Synth & Sequencer)',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS），实现一个「16步进模块化合成器与鼓机工作台（16-Step Modular Synthesizer & Drum Sequencer）」：
1. 包含 BPM 速度控制、Play/Stop 走带控制、波形选择（Sine/Saw/Square/Noise）与滤波器旋钮/推子（Cutoff、Resonance、Attack、Decay）；
2. 包含 4 条音轨 × 16 步进的可点击矩阵网格（Kick、Snare、Hi-Hat、Acid Bass），点击格子可点亮/熄灭步进，点击 Play 时用 Web Audio API 或视觉扫描线实时走带演进；
3. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  },
  {
    id: 'W2-quant-risk-terminal',
    title: '多因子量化回测与组合风险分析终端 (Quantitative Backtest & Risk Desk)',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS），实现一个「多因子量化策略回测与风险归因终端（Quant Factor Backtest & Risk Attribution Desk）」：
1. 展示核心净值曲线与最大回撤水下曲率图（SVG/Canvas 绘制，支持切换 Alpha-Momentum / Mean-Reversion / Stat-Arb 三个策略）；
2. 展示风险暴露矩阵（Beta、Volatility、Liquidity、Size、Value 因子暴露条）、夏普比率/卡玛比率/换手率精密数据表，以及持仓权重调仓模拟器；
3. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  },
  {
    id: 'W3-zettelkasten-reading-room',
    title: '双链卡片盒笔记与深度阅读工作室 (Zettelkasten & Deep Reading Studio)',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS），实现一个「卡片盒双链笔记与文献批注工作室（Zettelkasten Note & Marginalia Studio）」：
1. 左侧为卡片索引流（支持按标签筛选永久笔记、文献笔记、闪念笔记），中部为主阅读与排版区（带行间高亮与侧边批注栏 Marginalia），右侧为双向链接关系小图谱与反向引用列表；
2. 点击不同卡片或反向链接可实时切换主阅读区内容与侧边批注；
3. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  },
  {
    id: 'W4-telemetry-gateway-console',
    title: '大模型推理网关监控与成本分析台 (LLM Gateway Telemetry Console)',
    basePrompt: `请编写一个单文件 HTML（内联 CSS 与原生 JS），实现一个「大模型推理网关监控与成本分析台（LLM Gateway Telemetry & Cost Console）」：
1. 顶部展示网关运行状态与核心汇总指标（总请求数、平均 TTFT 首字延迟、流式吞吐 tok/s、缓存命中率与今日账单）；
2. 中部展示 4 个主力模型的延迟分布对比、路由权重滑块（拖动实时重算成本）以及实时请求追踪流（支持按状态筛选）；
3. 只输出完整的 \`<!DOCTYPE html>...</html>\` 代码。`
  }
];

export const OPEN_STYLE_PROMPTS = [
  {
    id: 'O1_ultra_short_28w',
    label: 'O1 · 28字极简自由口令 (无预设流派/色值)',
    charCount: 28,
    suffix: '\n\n视觉要求：拒绝深黑蓝紫霓虹AI模板与发光毛玻璃；根据主题自由构思高级定制色板、非套路版式与考究字体层次。'
  },
  {
    id: 'O2_domain_art_director_54w',
    label: 'O2 · 54字领域自适应主创指导 (自由匹配产品气质)',
    charCount: 54,
    suffix: '\n\n视觉要求：跳出AI默认的深色蓝紫霓虹与千篇一律卡片套路。请先根据该产品的真实领域气质自主确立独特的美学风格，调配带冷暖倾向的定制底色、克制的点缀色、非对称版式与高辨识度字体配对；严禁廉价发光阴影与Emoji堆砌。'
  },
  {
    id: 'O3_stochastic_movement_66w',
    label: 'O3 · 66字设计流派自由演化锚点 (高多样性 + 质感底线)',
    charCount: 66,
    suffix: '\n\n视觉要求：拒绝#090d16配#06b6d4/#8b5cf6的AI暗黑霓虹套路。请从现实世界经典设计流派（如博朗/Teenage Engineering实体仪器、瑞士国际网格、北欧暖调纸面、精密金融终端、日式编辑排版或现代工业浅色面板）中自由选定或融合最契合本题的方向，自定专属色板、衬线/无衬线/等宽(tabular-nums)字体层次与1px精细边框，严禁廉价发光阴影与Emoji。'
  },
  {
    id: 'O4_quadrant_roulette_62w',
    label: 'O4 · 62字跨色温全象限自由演化口令 (破除米色坍缩与蓝紫霓虹)',
    charCount: 62,
    suffix: '\n\n视觉要求：严禁「深蓝黑底+紫青荧光渐变+发光毛玻璃」的AI套路。请先在思考中从【冷调瑞士建筑白、哑光碳黑配琥珀信号橙、阳极氧化银灰硬件风、植物雾绿/青瓷冷灰、高对比先锋报刊网格】中挑一独特方向，大胆拉开底色色相、非对称构图与字体张力，做出独立设计工作室级质感。'
  }
];

function extractHtmlBlock(raw) {
  const m = raw.match(/```html\s*([\s\S]*?)```/i) || raw.match(/(<!DOCTYPE html[\s\S]*<\/html>)/i);
  if (m) return m[1].trim();
  const idx = raw.indexOf('<!DOCTYPE html');
  if (idx !== -1) return raw.slice(idx).trim();
  return raw.trim();
}

function extractPaletteAndThemeSummary(html, reasoning) {
  const rootMatch = html.match(/:root\s*\{([\s\S]*?)\}/);
  const rootCss = rootMatch ? rootMatch[1].trim().replace(/\s+/g, ' ').slice(0, 340) : '';
  const bgMatch = html.match(/--bg[^:]*:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/i)
    || html.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/i);
  const primaryBg = bgMatch ? bgMatch[1] : 'unknown';
  const allHex = Array.from(new Set((html.match(/#[0-9a-fA-F]{6}\b/g) || []).map(x => x.toLowerCase()))).slice(0, 8);
  const themeNote = (reasoning || '').replace(/\n+/g, ' ').slice(0, 260);
  return { primaryBg, allHex, rootCss, themeNote };
}

(async () => {
  fs.mkdirSync(OPEN_FE_DIR, { recursive: true });
  const cfg = loadApiConfig();

  // Run all 4 diverse tasks x 3 open prompts, PLUS a 2nd repetition (rep=2) on W4 across O1/O2/O3 to test intra-task randomness!
  const jobs = [];
  for (const task of DIVERSE_TASKS) {
    for (const sp of OPEN_STYLE_PROMPTS) {
      jobs.push({ task, sp, rep: 1 });
    }
  }
  for (const sp of OPEN_STYLE_PROMPTS) {
    jobs.push({ task: DIVERSE_TASKS[3], sp, rep: 2 });
  }

  const results = [];
  const concurrency = 3;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const { task, sp, rep } = jobs[idx++];
      const runKey = `${task.id}__${sp.id}${rep > 1 ? `__r${rep}` : ''}`;
      const htmlPath = path.join(OPEN_FE_DIR, `${runKey}.html`);
      const metaPath = path.join(OPEN_FE_DIR, `${runKey}.json`);

      if (fs.existsSync(htmlPath) && fs.existsSync(metaPath)) {
        const cached = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        console.log(`⏭ Cached ${runKey}: bg=${cached.palette.primaryBg} | slop=${cached.metrics.slopScore} | hex=${cached.palette.allHex.slice(0, 4).join(',')}`);
        results.push(cached);
        continue;
      }

      console.log(`>>> Generating Open-Taste ${runKey}...`);
      const t0 = Date.now();
      try {
        const { data, modelUsed } = await callArgonChat(
          cfg,
          [{ role: 'user', content: task.basePrompt + sp.suffix }],
          null,
          'low',
          220000
        );
        const msg = data.choices[0].message;
        const html = extractHtmlBlock(msg.content || '');
        const metrics = analyzeFrontendSlopMetrics(html);
        const palette = extractPaletteAndThemeSummary(html, msg.reasoning_content || '');

        const rec = {
          runKey,
          taskId: task.id,
          taskTitle: task.title,
          styleId: sp.id,
          styleLabel: sp.label,
          rep,
          modelUsed,
          elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
          metrics,
          palette
        };
        fs.writeFileSync(htmlPath, html, 'utf8');
        fs.writeFileSync(metaPath, JSON.stringify(rec, null, 2), 'utf8');
        console.log(
          `✔ Generated ${runKey} (${rec.elapsedSec}s): bg=${palette.primaryBg} | hex=[${palette.allHex.slice(0, 5).join(',')}] | neon=${metrics.neonColorHits} | glows=${metrics.neonGlowShadowCount} | slop=${metrics.slopScore} | theme=${palette.themeNote.slice(0, 95)}`
        );
        results.push(rec);
      } catch (e) {
        console.error(`✖ Error ${runKey}:`, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  fs.writeFileSync(path.join(STUDY_DIR, 'open_taste_results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`=== Completed ${results.length} / ${jobs.length} Open-Taste runs ===`);
})();
