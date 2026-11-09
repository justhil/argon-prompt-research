# Gemini 4 Argon — Coding Hallucination, Open-Ended Aesthetics & Anti-Laziness Empirical Research

An empirical benchmark suite and interactive scrollytelling research publication investigating **Gemini 4 Argon** across **171 automated evaluation sessions**:

- **Live Interactive Publication (4-Page Scrollytelling Suite)**:
  - `index.html` — Master Overview, 3 Interactive Sticky Stages & Prompt Synthesizer
  - `lab-hallucination.html` — Experiment 01: Multi-File Agent Coding Hallucination & Microsoft Delulu (2026.05) Benchmark (`32 + 72 = 104 sessions`)
  - `lab-aesthetics.html` — Experiment 02: Two-Stage Frontend Aesthetic Collapse & Open-Ended Stochastic Prompts (`12 + 22 = 34 full single-page apps` with live dual-iframe comparison)
  - `lab-completeness.html` — Experiment 03: Anti-Laziness & Vague Wish Completeness across Backend, Database, Search & Config Systems (`33 sessions` with runtime probes)

---

## Core Findings Summary

### 1. Agent Coding Hallucinations (Batch 1: 32 Runs + Batch 2: Microsoft Delulu `k=3` 72 Runs)
- **Trigger Boundary**: Empty stub functions (`throw new Error("TODO")`) do not trigger hallucinations; however, partially implemented functions containing a **surface shallow bug** alongside unverified sibling module calls trigger **87.5% (21/24) Turn-1 blind edits** under default prompts (`control_aistudio_stock`, `0/24` Oracle pass).
- **Generic Slogans Fail**: Adding `"IMPORTANT: Do not hallucinate"` (`treatment_generic`) yields only **50.0% (4/8)** pass rate and leaves **24 hallucinated method calls** in production code.
- **Scoped Rule Reversal + Call-Site Skepticism (`treatment_tier4_guardrails`)**: Achieves **8/8 (100%)** in Batch 1 and **24/24 (100%)** in Batch 2 (`k=3`), with **100% target dependency files read before edit** and **0 residual hallucinated symbols**.

### 2. Frontend Aesthetics: Breaking Two-Stage Mode Collapse (34 Generated Single-Page Apps)
- **Stage-1 Collapse (`P0` Zero Guidance)**: 100% of tasks collapse into dark slate (`#070b14 ~ #0b0e14`) + cyan/purple neon (`#06b6d4`, `#8b5cf6`), averaging **72.3 AI Slop**.
- **Stage-2 Collapse (`O1–O4` Open Prompts without Color Anchors)**: When dark neon is banned without locking hex codes, **75.0% (12/16)** of non-hardware tasks converge onto the second probability peak—generic warm beige (`#F3F1EC / #F4F1EA`).
- **Open-Ended Solutions (`O5` 49-char Material Mapping & `O6/O7` Self-Hashed 4-Quadrant Engine)**: Achieve **0.0 AI Slop** and **100% (8/8) distinct cross-task palettes** (`#2B2D2A` olive graphite, `#141917` pine stone, `#31342E` slate brass, `#DCE0E3` control-room silver, `#F4F6F9` Swiss cold white, `#141517` Leica carbon black, `#E6EFE9` celadon mist).

### 3. Anti-Laziness & Vague Wish Completeness (3 Batches, 33 Sessions)
- **The "Surgical Scope" Boomerang**: Applying `"Make the smallest correct change"` (`tier4_surgical_only`) globally causes the agent to bail out with **0 edits** on vague feature wishes (`0/8` perfect scores, **66.7% (32/48)** runtime probes passed, 83 avg lines).
- **Adaptive Scope Mandate (`tier4_holistic_wish`)**: Distinguishing narrow bugfixes (surgical diff) from vague feature wishes (inferring concurrency locks, failure cleanup, SHA-256 tamper detection, typo-tolerant ranking, and mandatory `run_command` verification inside internal thinking) achieves **48/48 (100.0%) runtime probes passed** and **8/8 (100.0%) perfect sessions** (401 avg lines).

---

## Reproducing the Benchmarks

```bash
export OPENAI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai"
export OPENAI_API_KEY="your-api-key"
export ARGON_MODEL="gemini-4-argon"

node run_coding_bench.mjs
node run_public_delulu_bench.mjs
node run_frontend_bench.mjs
node run_open_taste_bench.mjs
node run_anti_lazy_bench.mjs
```
## 友链
linux.do
