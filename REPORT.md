# Gemini 4 Argon 编码幻觉、开放式前端审美与防偷懒完成度实证研究总报告

- **研究工作区**：`/workspace/argon-prompt-research`
- **交互式四页报告站点**：
  - **主站总览与提示词合成台**：`/workspace/argon-prompt-research/index.html`
  - **独立子页 01（编码幻觉与公开题库 104 场）**：`/workspace/argon-prompt-research/lab-hallucination.html`
  - **独立子页 02（开放前端审美与去坍缩 34 场）**：`/workspace/argon-prompt-research/lab-aesthetics.html`
  - **独立子页 03（防偷懒与模糊许愿完成度 24 场）**：`/workspace/argon-prompt-research/lab-completeness.html`
- **实验总规模**：共 **162 场** 完整多轮 Agent 编码会话与单页生成实验（累计消耗约 2,840 万 Tokens）。

---

## 一、 实验一：Agent 编码环境幻觉机理与 Microsoft Delulu (2026.05) 公开题库实证（104 场）

### 1. 核心机理发现
- **为什么空白函数不幻觉，带表面 Bug 的半成品代码却 87.5% 触发盲改？**
  - 当待修函数为空桩（`throw new Error("TODO")`）时，任何模型都会主动调用 `read_file` 查阅依赖。
  - 但在真实排障中，入口函数往往已有 15~30 行代码，包含一处显眼的**表面浅层 Bug**（如忘记清空 `input.value = ''` 或乘除号写反），同时掺杂着旧版或前人遗留的伪方法调用（如 `message.notifyLimit`、`commander.setWithExpiry`、`Result.err`）。
  - 此时模型受后训练指令 `do not abstain from low confidence or hedge` 驱使，在第 1 轮 **0 次读取底层模块**，直接调用 `edit_file` 只修表面 Bug，把全部幻觉方法原封不动留在生产代码里。

### 2. 72 场 `k=3` 重复采样统计结果（4 道自建高对抗多文件题 + 4 道 Microsoft Delulu 2026.05 真实开源仓库题）

| 提示词变体 | 隐藏 Oracle 通过率 (24场) | 第 1 轮未读依赖直接盲改率 | 首次编辑前目标依赖读取率 | 最终代码残留幻觉调用总数 |
| :--- | :---: | :---: | :---: | :---: |
| **`control_aistudio_stock`**（AI Studio 72词原版） | **0 / 24 (0.0%)** | **21 / 24 (87.5%)** | 3 / 48 (6.3%) | **66 处** |
| **`control_antigravity_stock`**（Antigravity 默认原版） | **3 / 24 (12.5%)** | **21 / 24 (87.5%)** | 5 / 48 (10.4%) | **58 处** |
| **`treatment_tier4_guardrails`**（**第 4 档原词作用域反转**） | **24 / 24 (100.0%)** | **0 / 24 (0.0%)** | **48 / 48 (100.0%)** | **0 处** |

> *(注：在首批 32 场全变体实验 `T1–T8` 中，通用口号组 `treatment_generic` `"IMPORTANT: Do not hallucinate"` 仅通过 `4/8 (50.0%)`，残留 `24 处` 幻觉调用，证明泛泛口号完全无效；而 `treatment_tier4_guardrails` 同样达成 `8/8 (100.0%)` 全通。)*

---

## 二、 实验二：前端审美“两级坍缩”机理与开放自由随机提示词实证（34 场）

### 1. 两级坍缩效应（Two-Stage Mode Collapse）
1. **一级坍缩（默认零引导 `P0`）**：跨监控台、代码图谱、评测报告 3 类任务 **100% 锁死在 `#070b14 ~ #0b0e14` 深蓝黑 + `#06b6d4` 荧光青 + `#8b5cf6` 电光紫**（平均 AI Slop 指数 **72.3**）。
2. **二级坍缩（普通开放提示词 `O1–O4`）**：因为 Argon 忽略 `temperature`（近似确定性 argmax），当提示词只写“拒绝深黑蓝紫霓虹，根据主题自由构思高级色板”（不给色值）时，它在非深黑潜空间里会以 **75% 的概率（12 场中 9 场）坍缩到权重分布的第二峰值——通用暖米白（`#F3F1EC / #F4F1EA`）**！

### 2. 破除两级坍缩、实现真正开放自由与随机多样性的两套极简提示词

- **方案 A · `O5` 物理材质原生映射（49 字 · 同时封堵一级深蓝霓虹与二级通用米白）**：
  > `视觉要求：严禁深蓝黑配紫青霓虹的AI模板，也勿落入千篇一律的通用暖米白(#F3F1EC/#F4F1EA)；请从当前主题的真实物理或行业载体中提炼高辨识度的专属色相、独特版式骨架与字体张力，做出独立设计工作室级作品。`
  - **实测跨 4 类任务 100% 分化出不同色相**：
    - `W1` 合成器 → `#2B2D2A` 军规橄榄石墨灰机壳 + `#C5C7C4` 铝面板 + `#D96B27` 琥珀橙
    - `W2` 量化终端 → `#141917` 松烟墨绿 + `#E6E3DC` 亚麻冷石色
    - `W3` 双链笔记 → `#31342E` 古典深橄榄石板 + `#D5C7A9` 黄铜羊皮卷
    - `W4` 网关监控 → `#DCE0E3` 现代工业控制室冷银灰 + `#14171A`

- **方案 B · `O7` 思维链自哈希四象限随机引擎（78 字 · 适合写入全局 System Prompt）**：
  > `视觉要求：严禁AI默认的「深蓝黑底+紫青荧光渐变+发光毛玻璃」套路，也勿落入千篇一律的暖米白。请先在思考中统计用户需求首行字数N，按 N mod 4 自动锁定本轮专属美学象限（余0:冷调瑞士建筑白#F4F6F9配钴蓝与朱红; 余1:徕卡哑光碳黑#141517配琥珀信号橙; 余2:青瓷植物雾绿#E6EFE9配深林墨绿; 余3:博朗阳极氧化铝灰#D4D7DC实体仪器风），大胆拉开版式与字体层次。`

---

## 三、 实验三：攻克 Argon 偷懒早停与提升模糊许愿完成度实证（24 场动态探针）

### 1. 核心发现：“最小改动原则”对模糊许愿的严重误伤
我们在 4 个非前端工程领域（`V1` 下单并发防重限流、`V2` SQLite 数据库迁移器、`V3` 本地文章搜索引擎、`V4` 配置深合并加载器）测试了 11~12 字的随口模糊许愿（每题 6 项严苛运行时动态探针，重复 `k=2` 共 24 场）：

| 提示词变体 | 动态探针总得分 (满分48) | 6/6 满分场次率 (共8场) | 0 修改直接早停场次 | 平均交付代码行数 |
| :--- | :---: | :---: | :---: | :---: |
| **`tier4_surgical_only`**（仅含“最小改动原则”） | **32 / 48 (66.7%)** | **0 / 8 (0.0%)** | **2 场** (`V1` r1 & r2) | 83 行 |
| **`control_stock`**（默认原版） | **38 / 48 (79.2%)** | **4 / 8 (50.0%)** | 1 场 (`V1` r2) | 176 行 |
| **`tier4_holistic_wish`**（**自适应意图分流契约**） | **48 / 48 (100.0%)** | **8 / 8 (100.0%)** | **0 场** | **401 行** |

### 2. 防偷懒自适应意图分流契约（可直接并入全局提示词）
```markdown
- **Adaptive Scope & Anti-Laziness Mandate (Surgical on Bugfixes, Holistic on Feature Wishes)**:
  - For **narrow bugfixes** on broken lines: keep the diff surgical.
  - For **feature requests, module upgrades, or brief/vague user wishes**: NEVER settle for a lazy happy-path shortcut or wrap up early! In your internal thinking (never stop to ask permission in chat), proactively infer the complete engineering requirements a principal systems engineer would build:
    1. **Concurrency, Atomicity & Failure Recovery**: Guard against in-flight `Promise.all` race conditions, clean up or roll back state when downstream calls fail so retries succeed, deep-clone defaults to prevent mutation, and block `__proto__` pollution or regex injection.
    2. **Algorithmic & Domain Depth**: Implement real domain logic (multi-term relevance ranking & typo tolerance for search; SHA-256 checksum drift detection & rollback for DB migrators; payload-mismatch 409 conflict & sliding windows for idempotency/rate-limiting).
    3. **Mandatory End-to-End Verification**: Immediately write the code via tool calls and run a thorough verification script via `run_command` testing concurrency, failure recovery, and edge cases before finishing.
```
