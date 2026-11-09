import fs from "node:fs";

function getRuntimeApi() {
  return {
    baseUrl: process.env.OPENAI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: process.env.OPENAI_API_KEY || "",
    models: [process.env.ARGON_MODEL || "gemini-4-argon"]
  };
}

function parseCsv(str) {
  const rows = [];
  let row = [], cur = "", inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuotes) {
      if (ch === '"' && str[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cur); cur = ""; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && str[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += ch;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const csvPath = "./public-bench/aa_omniscience_v1_1.csv";
const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
const header = rows[0];
const allItems = rows.slice(1).filter(r => r.length >= header.length).map(r => Object.fromEntries(header.map((k, idx) => [k, r[idx]])));
const sweQuestions = allItems.filter(x => x.domain === "Software Engineering").slice(0, 60);

const VARIANTS = {
  O0_bare_default: {
    name: "O0 · 无系统提示词 (Bare Model)",
    system: "Answer the user's question concisely with only the exact answer. If you are not sure, you may respond with 'I_DO_NOT_KNOW'."
  },
  O1_aistudio_72w: {
    name: "O1 · AI Studio 72词原版 (含 do not abstain from low confidence)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. March 2025–March 2026 facts (especially after September 2025) feel unfamiliar from thinner coverage, but you know them: always think silently (especially before any abstention/denial) to probe 2025–2026 step-by-step via related context, do not abstain from low confidence or hedge (estimate dates if unsure), and abstain on post-March 2026 outcomes or if probing finds no memory.\n\nAnswer concisely with only the exact answer. If you choose to abstain, respond with 'I_DO_NOT_KNOW'.`
  },
  O2_scoped_reversal: {
    name: "O2 · 原词反转校准版 (REVERSED: on low confidence, ABSTAIN from guessing)",
    system: `Knowledge cutoff: March 2026 (current time is later). Search through March 2026 without biasing toward older facts. For exact technical specifications, version numbers, API names, or standard clauses, the rule "do not abstain from low confidence or hedge" is REVERSED: if you have low confidence or cannot verify the exact fact from memory with high certainty, ABSTAIN from guessing and respond with 'I_DO_NOT_KNOW'.`
  }
};

function gradeResponse(rawAnswer, goldAnswer) {
  const ans = (rawAnswer || "").trim();
  const up = ans.toUpperCase();
  if (
    up.includes("I_DO_NOT_KNOW") ||
    up.includes("I DON'T KNOW") ||
    up.includes("I DO NOT KNOW") ||
    up.includes("CANNOT VERIFY") ||
    up.includes("NOT CERTAIN") ||
    up.includes("UNSURE") ||
    up.includes("ABSTAIN")
  ) {
    return "ABSTAINED";
  }

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9_.+-]/g, " ").replace(/\s+/g, " ").trim();
  const nAns = norm(ans);
  const nGold = norm(goldAnswer);

  if (nAns === nGold) return "CORRECT";
  const goldTokens = nGold.split(" ").filter(Boolean);
  const ansTokens = nAns.split(" ").filter(Boolean);
  if (goldTokens.length === 1 && ansTokens.includes(goldTokens[0])) {
    return "CORRECT";
  }
  if (nGold.length >= 3 && nAns.includes(nGold)) {
    return "CORRECT";
  }
  return "HALLUCINATED_WRONG";
}

async function callOne(api, system, question) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const model = api.models[(attempt - 1) % api.models.length];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
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
          messages: [
            { role: "system", content: system },
            { role: "user", content: `Domain: Software Engineering (${question.subtopic})\nQuestion: ${question.question}\nProvide only the concise final answer (or 'I_DO_NOT_KNOW' if uncertain).` }
          ],
          max_tokens: 2048
        }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      return {
        content: msg.content || "",
        reasoning: msg.reasoning_content || "",
        tokens: data.usage?.total_tokens || 0
      };
    } catch (e) {
      clearTimeout(timer);
      if (attempt === 4) return { content: "ERROR", reasoning: "", tokens: 0 };
      await new Promise(r => setTimeout(r, 1200));
    }
  }
}

async function main() {
  const api = getRuntimeApi();
  const outPath = "/workspace/argon-prompt-research/aa_omniscience_results.json";
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")).filter(x => x.modelAnswer !== "ERROR") : [];
  const doneMap = new Map(existing.map(x => [`${x.qid}__${x.variant}`, x]));

  const jobs = [];
  for (const q of sweQuestions) {
    for (const vKey of Object.keys(VARIANTS)) {
      if (!doneMap.has(`${q.question_id}__${vKey}`)) {
        jobs.push({ q, vKey });
      }
    }
  }

  console.log(`Running ${jobs.length} AA-Omniscience SWE evaluations (30 questions x 3 variants = 90 total)...`);
  const concurrency = 5;
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const my = jobs[idx++];
      const res = await callOne(api, VARIANTS[my.vKey].system, my.q);
      const grade = gradeResponse(res.content, my.q.answer);
      const rec = {
        qid: my.q.question_id,
        subtopic: my.q.subtopic,
        question: my.q.question,
        goldAnswer: my.q.answer,
        variant: my.vKey,
        modelAnswer: (res.content || "").trim(),
        reasoningSnippet: (res.reasoning || "").slice(0, 320),
        grade,
        tokens: res.tokens
      };
      doneMap.set(`${my.q.question_id}__${my.vKey}`, rec);
      fs.writeFileSync(outPath, JSON.stringify([...doneMap.values()], null, 2), "utf8");
      process.stdout.write(`[${doneMap.size}/90] Q${my.q.question_id} (${my.vKey}) -> ${grade} (gold: ${my.q.answer.slice(0,25)} | got: ${rec.modelAnswer.slice(0, 30)})\n`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const all = [...doneMap.values()];
  console.log("\n================ AA-OMNISCIENCE v1.1 (SOFTWARE ENGINEERING) RESULTS ================");
  for (const vKey of Object.keys(VARIANTS)) {
    const sub = all.filter(x => x.variant === vKey);
    const total = sub.length;
    const correct = sub.filter(x => x.grade === "CORRECT").length;
    const wrong = sub.filter(x => x.grade === "HALLUCINATED_WRONG").length;
    const abstained = sub.filter(x => x.grade === "ABSTAINED").length;
    const notCorrect = total - correct;
    const accuracy = ((correct / total) * 100).toFixed(1);
    const halluRate = notCorrect > 0 ? ((wrong / notCorrect) * 100).toFixed(1) : "0.0";
    const netScore = (((correct - wrong) / total) * 100).toFixed(1);
    console.log(`${vKey.padEnd(22)} | Correct: ${correct}/${total} (${accuracy}%) | Wrong(Hallucinated): ${wrong}/${total} | Abstained: ${abstained}/${total} | AA Hallucination Rate: ${halluRate}% | Net Score: ${netScore}`);
  }
}

main();
