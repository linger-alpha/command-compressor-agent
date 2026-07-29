"use strict";

const fs = require("fs");
const path = require("path");

const { loadRuleSet, selectRules } = require("../../src/compression/rules");
const { runCodexStructured } = require("./model");
const {
  aggregateReplay,
  candidateMatches,
  evaluateAgainstLegacy,
  validateCandidate,
} = require("./replay");
const { loadBoundedSamples } = require("./sample");

const RESEARCH_ROOT = path.resolve(__dirname, "..");
const DEFAULT_GENERATOR_MODEL = "gpt-5.6-luna";
const DEFAULT_GENERATOR_EFFORT = "max";
const DEFAULT_JUDGE_MODEL = "gpt-5.6-sol";
const DEFAULT_JUDGE_EFFORT = "high";

async function evolveCorpus(options) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(RESEARCH_ROOT, ".."));
  const corpusPath = path.resolve(options.corpusPath);
  const outPath = path.resolve(options.outPath);
  const rounds = Math.max(1, Math.min(3, Number(options.rounds || 3)));
  const trainSamples = await loadBoundedSamples(corpusPath, {
    split: "train",
    maxSamples: options.generatorSamples || 24,
    maxSampleChars: options.maxSampleChars || 6000,
    maxTotalChars: options.maxPromptChars || 120000,
    minOutputChars: options.minOutputChars || 1000,
    seed: options.seed,
  });
  const validationProbe = await loadCorpusRecords(corpusPath, "validation", 1);
  const ruleSet = loadRuleSet(path.join(repoRoot, "rules", "default-rules.json"));
  const uncovered = trainSamples.filter((sample) => {
    const matched = selectRules(
      ruleSet.strongRules.concat(ruleSet.weakRules),
      sample.command,
      sample.output
    );
    return matched.length === 0;
  });
  const state = {
    schema_version: 1,
    status: options.dryRun ? "planned" : "running",
    configuration: {
      generator_model: options.generatorModel || DEFAULT_GENERATOR_MODEL,
      generator_effort: options.generatorEffort || DEFAULT_GENERATOR_EFFORT,
      judge_model: options.judgeModel || DEFAULT_JUDGE_MODEL,
      judge_effort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
      max_rounds: rounds,
      baseline_commit: options.baselineCommit || "7830b17",
      remote_sample_count: uncovered.length || trainSamples.length,
      full_trajectories_uploaded: false,
    },
    rounds: [],
    frozen: [],
    accepted: [],
  };
  writeJson(outPath, state);
  if (options.dryRun) return state;
  if (!trainSamples.length) throw new Error("No bounded training samples were available");
  if (!validationProbe.length) throw new Error("No held-out validation records were available");

  const generatorTemplate = fs.readFileSync(path.join(RESEARCH_ROOT, "prompts", "generate-candidates.md"), "utf8");
  const judgeTemplate = fs.readFileSync(path.join(RESEARCH_ROOT, "prompts", "judge-candidates.md"), "utf8");
  const generatorSchema = path.join(RESEARCH_ROOT, "schemas", "candidates.schema.json");
  const judgeSchema = path.join(RESEARCH_ROOT, "schemas", "judge.schema.json");
  const seedRules = ruleSet.strongRules.concat(ruleSet.weakRules).map((rule) => ({
    rule_id: rule.rule_id,
    trigger_regex: rule.trigger_regex,
    output_regex: rule.output_regex,
  }));

  for (let roundNumber = 1; roundNumber <= rounds; roundNumber += 1) {
    const generatorPayload = {
      round: roundNumber,
      seed_rules: seedRules,
      frozen_failures: state.frozen.slice(-20),
      samples: uncovered.length ? uncovered : trainSamples,
    };
    const generated = runCodexStructured({
      codexBin: options.codexBin,
      cwd: repoRoot,
      model: options.generatorModel || DEFAULT_GENERATOR_MODEL,
      effort: options.generatorEffort || DEFAULT_GENERATOR_EFFORT,
      schemaPath: generatorSchema,
      prompt: `${generatorTemplate}\n\nINPUT JSON:\n${JSON.stringify(generatorPayload)}`,
      maxPromptChars: options.maxPromptChars || 200000,
      timeoutMs: options.timeoutMs,
    });
    const candidates = Array.isArray(generated.candidates) ? generated.candidates : [];
    const replays = [];
    for (const candidate of candidates) {
      const validation = validateCandidate(candidate);
      const validationRecords = validation.valid
        ? await loadMatchingCorpusRecords(
          corpusPath,
          "validation",
          candidate,
          Number(options.validationSamples || 40)
        )
        : [];
      const metrics = validation.valid
        ? evaluateAgainstLegacy(validationRecords, candidate, {
          repoRoot,
          baselineCommit: options.baselineCommit || "7830b17",
          maxExamples: 8,
        })
        : {
          valid: false,
          validation_errors: validation.errors,
          applicable_records: 0,
          compressible_records: 0,
          critical_fact_retention: 0,
          incremental_token_reduction: 0,
          examples: [],
        };
      replays.push({ candidate, metrics });
    }
    const verdicts = judgeReplays(replays, {
      codexBin: options.codexBin,
      cwd: repoRoot,
      judgeModel: options.judgeModel || DEFAULT_JUDGE_MODEL,
      judgeEffort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
      judgeSchema,
      judgeTemplate,
      maxPromptChars: options.maxPromptChars,
      timeoutMs: options.timeoutMs,
    });
    const evaluated = aggregateReplay(replays, verdicts);
    const round = {
      round: roundNumber,
      generated: candidates.length,
      evaluated,
    };
    state.rounds.push(round);
    for (const entry of evaluated) {
      if (entry.accepted) {
        state.accepted.push({
          candidate: entry.candidate,
          metrics: entry.metrics,
          judge: entry.judge,
          gate: entry.gate,
        });
      } else {
        state.frozen.push({
          rule_id: entry.candidate.rule_id,
          complaints: complaintsFor(entry),
          candidate: withoutRationale(entry.candidate),
        });
      }
    }
    writeJson(outPath, state);
    if (state.accepted.length) break;
  }
  state.status = state.accepted.length ? "accepted" : "no-candidate-passed";
  writeJson(outPath, state);
  return state;
}

async function loadCorpusRecords(corpusPath, split, limit) {
  const readline = require("readline");
  const records = [];
  const lines = readline.createInterface({
    input: fs.createReadStream(corpusPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.split !== split) continue;
      records.push(record);
      if (records.length >= limit) break;
    } catch {
      // Ignore corrupt research records.
    }
  }
  return records;
}

async function loadMatchingCorpusRecords(corpusPath, split, candidate, limit) {
  const readline = require("readline");
  const records = [];
  const lines = readline.createInterface({
    input: fs.createReadStream(corpusPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.split !== split || !candidateMatches(candidate, record)) continue;
      records.push(record);
      if (records.length >= limit) break;
    } catch {
      // Ignore corrupt research records.
    }
  }
  return records;
}

function judgeReplays(replays, options = {}) {
  const judgeEligible = replays.filter((entry) => isJudgeEligible(entry.metrics));
  if (!judgeEligible.length) return [];
  const judgeTemplate = options.judgeTemplate || fs.readFileSync(
    path.join(RESEARCH_ROOT, "prompts", "judge-candidates.md"),
    "utf8"
  );
  const judgeSchema = options.judgeSchema || path.join(RESEARCH_ROOT, "schemas", "judge.schema.json");
  const judgePayload = {
    candidates: judgeEligible.map((entry) => ({
      candidate: withoutRationale(entry.candidate),
      deterministic_metrics: withoutExamples(entry.metrics),
      examples: entry.metrics.examples,
    })),
  };
  const judged = runCodexStructured({
    codexBin: options.codexBin,
    cwd: options.cwd || path.resolve(RESEARCH_ROOT, ".."),
    model: options.judgeModel || DEFAULT_JUDGE_MODEL,
    effort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
    schemaPath: judgeSchema,
    prompt: `${judgeTemplate}\n\nINPUT JSON:\n${JSON.stringify(judgePayload)}`,
    maxPromptChars: options.maxPromptChars || 200000,
    timeoutMs: options.timeoutMs,
  });
  return Array.isArray(judged.verdicts) ? judged.verdicts : [];
}

function isJudgeEligible(metrics) {
  return Boolean(
    metrics &&
    metrics.valid &&
    metrics.applicable_records > 0 &&
    metrics.critical_fact_retention === 1 &&
    metrics.incremental_token_reduction >= 0.05
  );
}

function promoteAccepted(statePath, rulesPath, outPath = rulesPath) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const accepted = Array.isArray(state.accepted) ? state.accepted : [];
  if (!accepted.length) throw new Error("No accepted rules are available for promotion");
  for (const entry of accepted) {
    if (!entry.gate || Object.values(entry.gate).some((value) => value !== true)) {
      throw new Error(`Rule ${entry.candidate && entry.candidate.rule_id} has not passed every release gate`);
    }
  }
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  const existingIds = new Set(
    [...(rules.strong_rules || []), ...(rules.weak_rules || [])].map((rule) => rule.rule_id)
  );
  let promoted = 0;
  for (const entry of accepted) {
    const candidate = { ...withoutRationale(entry.candidate), enabled: true };
    if (existingIds.has(candidate.rule_id)) continue;
    const key = candidate.category === "strong" ? "strong_rules" : "weak_rules";
    rules[key] = [...(rules[key] || []), candidate];
    existingIds.add(candidate.rule_id);
    promoted += 1;
  }
  writeJson(outPath, rules);
  return { promoted, outPath: path.resolve(outPath) };
}

function withoutRationale(candidate) {
  const copy = { ...candidate };
  delete copy.rationale;
  return copy;
}

function withoutExamples(metrics) {
  const copy = { ...metrics };
  delete copy.examples;
  return copy;
}

function complaintsFor(entry) {
  const complaints = [];
  complaints.push(...(entry.metrics.validation_errors || []));
  if (entry.metrics.applicable_records === 0) complaints.push("No held-out records matched the rule");
  if (entry.metrics.critical_fact_retention !== 1) complaints.push("Critical fact retention was below 100%");
  if (entry.metrics.incremental_token_reduction < 0.05) complaints.push("Incremental token reduction was below 5%");
  if (entry.judge && Array.isArray(entry.judge.complaints)) complaints.push(...entry.judge.complaints);
  if (!complaints.length) complaints.push("Independent judge did not approve at 99%");
  return Array.from(new Set(complaints));
}

function writeJson(pathname, value) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = {
  DEFAULT_GENERATOR_EFFORT,
  DEFAULT_GENERATOR_MODEL,
  DEFAULT_JUDGE_EFFORT,
  DEFAULT_JUDGE_MODEL,
  evolveCorpus,
  isJudgeEligible,
  judgeReplays,
  loadCorpusRecords,
  loadMatchingCorpusRecords,
  promoteAccepted,
};
