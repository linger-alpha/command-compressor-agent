"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const {
  isCriticalContextLine,
  isCriticalLine,
} = require("../../src/compression/classifiers");
const { commandPassthroughReason } = require("../../src/compression/command-policy");
const { compressObservation } = require("../../src/compression/compressor");
const { outputLinesFromObservation } = require("../../src/compression/format");
const { loadRuleSet } = require("../../src/compression/rules");
const {
  hasDuplicatePattern,
  hasProgressPattern,
  isDenseSemanticBlock,
  isOpaqueEncodedBlock,
  isVisualStructureBlock,
} = require("../../src/compression/scorer");
const { splitBlocks } = require("../../src/compression/splitter");
const { runCodexStructured } = require("./model");
const { boundedRedacted } = require("./redaction");
const { regexSafety, withLegacyBaseline } = require("./replay");

const RESEARCH_ROOT = path.resolve(__dirname, "..");
const DEFAULT_GENERATOR_MODEL = "gpt-5.6-luna";
const DEFAULT_GENERATOR_EFFORT = "max";
const DEFAULT_JUDGE_MODEL = "gpt-5.6-sol";
const DEFAULT_JUDGE_EFFORT = "high";
const REQUIRED_KIND_SIGNALS = new Map([
  ["opaque_encoded", "opaque_encoded"],
  ["dense_semantic", "dense_semantic"],
  ["visual_structure", "visual"],
]);

function candidateFromRules(value, policyId = "rules_file_policy") {
  const blockPolicy = value.block_policy || value.blockPolicy || value.importance || {};
  const provenance = blockPolicy.provenance || {};
  return normalizeCandidate({
    policy_id: provenance.policy_id || policyId,
    rationale: "Policy loaded from a static rules file for deterministic replay.",
    default_tier: blockPolicy.default_tier || blockPolicy.defaultTier || "light",
    signals: blockPolicy.signals || [],
    opaque_encoded: blockPolicy.opaque_encoded || {},
    dense_semantic: blockPolicy.dense_semantic || {},
    visual: blockPolicy.visual || {},
    planner: value.planner || {},
    confidence: 0,
  });
}

function normalizeCandidate(candidate) {
  const value = candidate && typeof candidate === "object" ? candidate : {};
  return {
    ...value,
    policy_id: String(value.policy_id || ""),
    rationale: String(value.rationale || ""),
    default_tier: String(value.default_tier || "light"),
    signals: Array.isArray(value.signals)
      ? value.signals.map(normalizeSignal)
      : [],
    opaque_encoded: objectValue(value.opaque_encoded),
    dense_semantic: objectValue(value.dense_semantic),
    visual: objectValue(value.visual),
    planner: objectValue(value.planner),
    confidence: Number(value.confidence || 0),
  };
}

function normalizeSignal(signal) {
  const value = signal && typeof signal === "object" ? signal : {};
  const kind = String(value.kind || "");
  let pattern = String(value.pattern || "");
  let flags = String(value.flags || "");
  if (kind) {
    pattern = "";
    flags = "";
  } else {
    const inlineFlags = pattern.match(/^\(\?([ims]+)\)/);
    if (inlineFlags) {
      pattern = pattern.slice(inlineFlags[0].length);
      flags = Array.from(new Set(`${flags}${inlineFlags[1]}`.split(""))).sort().join("");
    }
  }
  return {
    id: String(value.id || ""),
    tier: String(value.tier || ""),
    kind,
    pattern,
    flags,
  };
}

function validatePolicyCandidate(input) {
  const candidate = normalizeCandidate(input);
  const errors = [];
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(candidate.policy_id)) {
    errors.push("policy_id must be a stable lowercase identifier");
  }
  if (!["light", "aggressive"].includes(candidate.default_tier)) {
    errors.push("default_tier must be light or aggressive");
  }
  if (candidate.signals.length < 8 || candidate.signals.length > 20) {
    errors.push("signals must contain 8 to 20 entries");
  }
  const ids = new Set();
  for (const signal of candidate.signals) {
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(signal.id)) {
      errors.push(`invalid signal id: ${signal.id || "<empty>"}`);
    }
    if (ids.has(signal.id)) errors.push(`duplicate signal id: ${signal.id}`);
    ids.add(signal.id);
    if (!["preserve", "light", "aggressive"].includes(signal.tier)) {
      errors.push(`invalid tier for ${signal.id}`);
    }
    if (signal.kind && signal.pattern) errors.push(`${signal.id} cannot use both kind and pattern`);
    if (!signal.kind && !signal.pattern) errors.push(`${signal.id} must use kind or pattern`);
    if (signal.kind && !["opaque_encoded", "dense_semantic", "visual", "progress", "duplicate"].includes(signal.kind)) {
      errors.push(`unsupported kind for ${signal.id}`);
    }
    if (signal.pattern) {
      const safety = regexSafety(signal.pattern);
      if (!safety.safe) errors.push(`${signal.id}: ${safety.reason}`);
      if (!/^(?:|i|m|im|mi)$/.test(signal.flags)) errors.push(`invalid flags for ${signal.id}`);
    }
  }
  for (const [id, kind] of REQUIRED_KIND_SIGNALS) {
    const signal = candidate.signals.find((entry) => entry.id === id);
    if (!signal || signal.kind !== kind || signal.tier !== "preserve") {
      errors.push(`${id} must remain a preserve signal with kind ${kind}`);
    }
  }
  requirePreservePattern(
    candidate,
    "traceback_exception",
    ["Traceback", "RuntimeException"],
    errors
  );
  requirePreservePattern(
    candidate,
    "error_failure",
    ["ERROR", "FATAL", "FAILED", "ValueError", "BuildFailure"],
    errors
  );
  requirePreservePattern(
    candidate,
    "critical_runtime_failure",
    [
      "Command timed out",
      "TimeoutError",
      "segmentation fault",
      "panic",
      "OOM",
      "undefined reference",
      "No such file or directory",
      "Permission denied",
      "npm ERR!",
      "Command failed",
    ],
    errors
  );
  const runtimeFailure = candidate.signals.find((entry) => entry.id === "critical_runtime_failure");
  if (runtimeFailure && runtimeFailure.pattern) {
    try {
      const expression = new RegExp(runtimeFailure.pattern, runtimeFailure.flags || "i");
      if (expression.test("--watchdog-timeout WATCHDOG_TIMEOUT")) {
        errors.push("critical_runtime_failure must not match CLI timeout option names");
      }
    } catch {
      // The general regex validator reports the syntax error.
    }
  }
  validateIntegerRange(candidate.opaque_encoded.minimum_encoded_chars, 64, 256, "opaque_encoded.minimum_encoded_chars", errors);
  validateIntegerRange(candidate.opaque_encoded.minimum_encoded_lines, 1, 2, "opaque_encoded.minimum_encoded_lines", errors);
  validateIntegerRange(candidate.dense_semantic.minimum_lines, 20, 160, "dense_semantic.minimum_lines", errors);
  validateIntegerRange(candidate.dense_semantic.minimum_numbered_lines, 10, 100, "dense_semantic.minimum_numbered_lines", errors);
  validateNumberRange(candidate.dense_semantic.minimum_numbered_ratio, 0.2, 0.9, "dense_semantic.minimum_numbered_ratio", errors);
  validateIntegerRange(candidate.visual.minimum_matrix_lines, 4, 20, "visual.minimum_matrix_lines", errors);
  validateStrategy(candidate.planner.light, "planner.light", errors);
  validateStrategy(candidate.planner.aggressive, "planner.aggressive", errors);
  if (
    validStrategy(candidate.planner.light) &&
    validStrategy(candidate.planner.aggressive)
  ) {
    for (const field of ["keep_first_n", "keep_last_n", "max_lines"]) {
      if (candidate.planner.aggressive[field] > candidate.planner.light[field]) {
        errors.push(`planner.aggressive.${field} must not exceed planner.light.${field}`);
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    candidate,
  };
}

async function loadPolicyRecords(corpusPath, options = {}) {
  const split = String(options.split || "validation");
  const limit = positiveInteger(options.limit, 300);
  const minOutputChars = positiveInteger(options.minOutputChars, 200);
  const seed = String(options.seed || "20260729");
  const ruleSet = loadRuleSet(options.rulesPath);
  const selected = [];
  const lines = readline.createInterface({
    input: fs.createReadStream(corpusPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.split !== split) continue;
    const output = `${record.stdout || ""}\n${record.stderr || ""}`.trim();
    if (output.length < minOutputChars) continue;
    if (commandPassthroughReason(record.command, "", ruleSet.commandPolicy)) continue;
    const key = digest(`${seed}:${record.source || ""}:${record.session_id || ""}:${record.id || ""}`);
    selected.push({ key, record });
    selected.sort((left, right) => left.key.localeCompare(right.key));
    if (selected.length > limit * 2) selected.length = limit * 2;
  }
  return selected.slice(0, limit).map((entry) => entry.record);
}

function buildTrainingBlockSamples(records, options = {}) {
  const limit = positiveInteger(options.limit, 32);
  const maxBlockChars = positiveInteger(options.maxBlockChars, 4000);
  const maxTotalChars = positiveInteger(options.maxTotalChars, 120000);
  const seed = String(options.seed || "20260729");
  const candidates = [];
  for (const record of records) {
    const observation = observationFromRecord(record);
    const blocks = splitBlocks(outputLinesFromObservation(observation));
    for (const block of blocks) {
      if (block.separator) continue;
      const rawText = block.lines.join("\n");
      if (rawText.trim().length < 80) continue;
      const text = boundedRedacted(rawText, maxBlockChars).text;
      const sample = {
        sample_id: String(record.id || ""),
        source: String(record.source || ""),
        command: boundedRedacted(record.command, 500).text,
        exit_code: record.exit_code == null ? null : Number(record.exit_code),
        sample_class: trainingSampleClass(block),
        block: text,
      };
      candidates.push({
        key: digest(`${seed}:${sample.sample_id}:${block.startLine}:${text.slice(0, 200)}`),
        bucket: `${sample.source}\0${sample.sample_class}`,
        sample,
      });
    }
  }
  const buckets = new Map();
  for (const entry of candidates) {
    if (!buckets.has(entry.bucket)) buckets.set(entry.bucket, []);
    buckets.get(entry.bucket).push(entry);
  }
  for (const entries of buckets.values()) {
    entries.sort((left, right) => left.key.localeCompare(right.key));
  }
  const orderedBuckets = Array.from(buckets.entries()).sort((left, right) =>
    digest(`${seed}:${left[0]}`).localeCompare(digest(`${seed}:${right[0]}`))
  );
  const output = [];
  let totalChars = 0;
  let index = 0;
  while (output.length < limit) {
    let added = false;
    for (const [, entries] of orderedBuckets) {
      const entry = entries[index];
      if (!entry) continue;
      const chars = JSON.stringify(entry.sample).length;
      if (totalChars + chars > maxTotalChars) continue;
      output.push(entry.sample);
      totalChars += chars;
      added = true;
      if (output.length >= limit) break;
    }
    if (!added) break;
    index += 1;
  }
  return output;
}

function trainingSampleClass(block) {
  if (block.kind === "opaque" || isOpaqueEncodedBlock(block.lines)) return "protected";
  if (block.kind === "critical" || block.lines.some(isCriticalFactLine)) return "critical";
  if (hasProgressPattern(block.lines)) return "progress";
  if (hasDuplicatePattern(block.lines)) return "duplicate";
  return "ordinary";
}

function evaluatePolicyAgainstLegacy(records, input, options = {}) {
  const validation = validatePolicyCandidate(input);
  if (!validation.valid) return invalidMetrics(validation.errors);
  const candidate = validation.candidate;
  const repoRoot = path.resolve(options.repoRoot || path.resolve(RESEARCH_ROOT, ".."));
  return withLegacyBaseline(repoRoot, options.baselineCommit || "7830b17", (legacy) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-block-policy-replay-"));
    try {
      const rulesPath = path.join(tempDir, "candidate-rules.json");
      const rules = JSON.parse(fs.readFileSync(path.join(repoRoot, "rules", "default-rules.json"), "utf8"));
      applyCandidateToRules(rules, candidate, "candidate");
      fs.writeFileSync(rulesPath, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
      const totals = {
        raw: 0,
        legacy: 0,
        candidate: 0,
        changed: 0,
        critical: 0,
        criticalRetained: 0,
        legacyCriticalRetained: 0,
        protected: 0,
        protectedRetained: 0,
        legacyProtectedRetained: 0,
        diagnostics: 0,
        tierLines: {},
        tierBlocks: {},
        preserveReasonLines: {},
        preserveReasonBlocks: {},
      };
      const examples = [];
      const lossExamples = [];
      const comparisons = [];
      const sourceTotals = new Map();
      for (const [index, record] of records.entries()) {
        const observation = observationFromRecord(record);
        const legacyResult = legacy.compressObservation(observation, {
          strength: "xhigh",
          rawDir: path.join(tempDir, "old-raw"),
          rulesPath: path.join(legacy.root, "rules", "default-rules.json"),
        });
        const currentResult = compressObservation(observation, {
          strength: "xhigh",
          rawDir: path.join(tempDir, "new-raw"),
          rulesPath,
        });
        const legacyEffective = legacyResult.changed
          ? legacyResult.compressedTokensEst
          : legacyResult.rawTokensEst;
        const candidateEffective = currentResult.changed
          ? currentResult.compressedTokensEst
          : currentResult.rawTokensEst;
        totals.raw += currentResult.rawTokensEst;
        totals.legacy += legacyEffective;
        totals.candidate += candidateEffective;
        if (currentResult.changed) totals.changed += 1;
        const source = String(record.source || "unknown");
        const sourceEntry = sourceTotals.get(source) || {
          records: 0,
          raw_tokens_est: 0,
          legacy_tokens_est: 0,
          candidate_tokens_est: 0,
        };
        sourceEntry.records += 1;
        sourceEntry.raw_tokens_est += currentResult.rawTokensEst;
        sourceEntry.legacy_tokens_est += legacyEffective;
        sourceEntry.candidate_tokens_est += candidateEffective;
        sourceTotals.set(source, sourceEntry);
        comparisons.push({
          sample_id: String(record.id || `sample-${index + 1}`),
          source,
          command: boundedRedacted(record.command, 500).text,
          raw_tokens_est: currentResult.rawTokensEst,
          legacy_tokens_est: legacyEffective,
          candidate_tokens_est: candidateEffective,
          delta_vs_legacy: candidateEffective - legacyEffective,
          legacy_changed: Boolean(legacyResult.changed),
          candidate_changed: Boolean(currentResult.changed),
          candidate_rules: currentResult.ruleIds,
          candidate_tiers: tierCounts(currentResult.plan && currentResult.plan.blocks),
        });
        const effectiveText = currentResult.text;
        const legacyEffectiveText = legacyResult.text;
        observePlanDiagnostics(currentResult.plan, totals);
        const originalLines = outputLinesFromObservation(observation);
        const criticalLines = criticalLinesForOutput(originalLines);
        totals.critical += criticalLines.length;
        const missingCritical = criticalLines.filter((line) => !effectiveText.includes(line));
        totals.criticalRetained += criticalLines.length - missingCritical.length;
        totals.legacyCriticalRetained += criticalLines.filter((line) =>
          legacyEffectiveText.includes(line)
        ).length;
        const protectedBlocks = splitBlocks(originalLines).filter((block) =>
          !block.separator && isProtectedBlock(block, candidate)
        );
        totals.protected += protectedBlocks.length;
        totals.protectedRetained += protectedBlocks.filter((block) =>
          effectiveText.includes(block.lines.join("\n"))
        ).length;
        totals.legacyProtectedRetained += protectedBlocks.filter((block) =>
          legacyEffectiveText.includes(block.lines.join("\n"))
        ).length;
        if (hasSyntheticDiagnostics(effectiveText)) totals.diagnostics += 1;
        if (missingCritical.length && lossExamples.length < 8) {
          lossExamples.push({
            sample_id: String(record.id || `sample-${index + 1}`),
            source: String(record.source || ""),
            command: boundedRedacted(record.command, 800).text,
            missing_critical_lines: missingCritical.slice(0, 20),
            original: boundedRedacted(`${record.stdout || ""}\n${record.stderr || ""}`.trim(), 4000).text,
            compressed: boundedRedacted(effectiveText, 4000).text,
          });
        }
        if (examples.length < positiveInteger(options.maxExamples, 10)) {
          examples.push({
            sample_id: String(record.id || `sample-${index + 1}`),
            source: String(record.source || ""),
            command: boundedRedacted(record.command, 800).text,
            original: boundedRedacted(`${record.stdout || ""}\n${record.stderr || ""}`.trim(), 4000).text,
            compressed: boundedRedacted(effectiveText, 4000).text,
            legacy_tokens_est: legacyEffective,
            candidate_tokens_est: candidateEffective,
          });
        }
      }
      return {
        valid: true,
        validation_errors: [],
        eligible_records: records.length,
        changed_records: totals.changed,
        raw_tokens_est: totals.raw,
        legacy_tokens_est: totals.legacy,
        candidate_tokens_est: totals.candidate,
        raw_token_reduction: totals.raw
          ? (totals.raw - totals.candidate) / totals.raw
          : 0,
        incremental_token_reduction: totals.legacy
          ? (totals.legacy - totals.candidate) / totals.legacy
          : 0,
        critical_fact_retention: totals.critical
          ? totals.criticalRetained / totals.critical
          : 1,
        legacy_critical_fact_retention: totals.critical
          ? totals.legacyCriticalRetained / totals.critical
          : 1,
        protected_block_retention: totals.protected
          ? totals.protectedRetained / totals.protected
          : 1,
        legacy_protected_block_retention: totals.protected
          ? totals.legacyProtectedRetained / totals.protected
          : 1,
        critical_lines: totals.critical,
        protected_blocks: totals.protected,
        model_visible_diagnostic_outputs: totals.diagnostics,
        tier_lines: sortCountObject(totals.tierLines),
        tier_blocks: sortCountObject(totals.tierBlocks),
        preserve_reason_lines: sortCountObject(totals.preserveReasonLines),
        preserve_reason_blocks: sortCountObject(totals.preserveReasonBlocks),
        by_source: Object.fromEntries(Array.from(sourceTotals, ([source, entry]) => [
          source,
          {
            ...entry,
            incremental_token_reduction: entry.legacy_tokens_est
              ? (entry.legacy_tokens_est - entry.candidate_tokens_est) / entry.legacy_tokens_est
              : 0,
          },
        ])),
        top_regressions: comparisons
          .filter((entry) => entry.delta_vs_legacy > 0)
          .sort((left, right) => right.delta_vs_legacy - left.delta_vs_legacy)
          .slice(0, 8),
        top_improvements: comparisons
          .filter((entry) => entry.delta_vs_legacy < 0)
          .sort((left, right) => left.delta_vs_legacy - right.delta_vs_legacy)
          .slice(0, 8),
        examples,
        loss_examples: lossExamples,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

async function replayBlockPolicy(options) {
  const validation = validatePolicyCandidate(options.candidate);
  const repetitions = Math.max(1, Math.min(10, positiveInteger(options.repetitions, 3)));
  const repeats = [];
  if (!validation.valid) {
    return {
      policy_id: validation.candidate.policy_id,
      repeats: [invalidMetrics(validation.errors)],
      aggregate: aggregatePolicyMetrics([invalidMetrics(validation.errors)]),
    };
  }
  for (let index = 0; index < repetitions; index += 1) {
    const seed = `${options.seed || "20260729"}:${index + 1}`;
    const records = await loadPolicyRecords(options.corpusPath, {
      split: options.split || "validation",
      limit: options.limit || 300,
      minOutputChars: options.minOutputChars || 200,
      seed,
      rulesPath: path.join(options.repoRoot || path.resolve(RESEARCH_ROOT, ".."), "rules", "default-rules.json"),
    });
    const metrics = evaluatePolicyAgainstLegacy(records, validation.candidate, options);
    repeats.push({ repetition: index + 1, seed, ...metrics });
  }
  return {
    policy_id: validation.candidate.policy_id,
    repeats,
    aggregate: aggregatePolicyMetrics(repeats),
  };
}

function aggregatePolicyMetrics(repeats) {
  const valid = repeats.length > 0 && repeats.every((entry) => entry.valid);
  const reductions = repeats.map((entry) => Number(entry.incremental_token_reduction || 0));
  const rawReductions = repeats.map((entry) => Number(entry.raw_token_reduction || 0));
  const sourceReductions = repeats.flatMap((entry) =>
    Object.values(objectValue(entry.by_source)).map((source) =>
      Number(source.incremental_token_reduction || 0)
    )
  );
  return {
    valid,
    repetitions: repeats.length,
    eligible_records: repeats.reduce((sum, entry) => sum + Number(entry.eligible_records || 0), 0),
    median_incremental_token_reduction: median(reductions),
    minimum_incremental_token_reduction: reductions.length ? Math.min(...reductions) : 0,
    median_raw_token_reduction: median(rawReductions),
    minimum_source_incremental_token_reduction: sourceReductions.length
      ? Math.min(...sourceReductions)
      : 0,
    critical_fact_retention: repeats.length
      ? Math.min(...repeats.map((entry) => Number(entry.critical_fact_retention || 0)))
      : 0,
    protected_block_retention: repeats.length
      ? Math.min(...repeats.map((entry) => Number(entry.protected_block_retention || 0)))
      : 0,
    model_visible_diagnostic_outputs: repeats.reduce(
      (sum, entry) => sum + Number(entry.model_visible_diagnostic_outputs || 0),
      0
    ),
    tier_lines: mergeCountObjects(repeats.map((entry) => entry.tier_lines)),
    tier_blocks: mergeCountObjects(repeats.map((entry) => entry.tier_blocks)),
    preserve_reason_lines: mergeCountObjects(
      repeats.map((entry) => entry.preserve_reason_lines)
    ),
    preserve_reason_blocks: mergeCountObjects(
      repeats.map((entry) => entry.preserve_reason_blocks)
    ),
    every_repeat_improves_legacy_5pct: reductions.length > 0 && reductions.every((value) => value >= 0.05),
  };
}

function deterministicPolicyGate(replay) {
  const metrics = replay && replay.aggregate ? replay.aggregate : {};
  return {
    candidate_valid: metrics.valid === true,
    held_out_records_present: Number(metrics.eligible_records) > 0,
    critical_fact_retention_100pct: Number(metrics.critical_fact_retention) === 1,
    protected_block_retention_100pct: Number(metrics.protected_block_retention) === 1,
    no_model_visible_diagnostics: Number(metrics.model_visible_diagnostic_outputs) === 0,
    every_repeat_incremental_reduction_5pct: metrics.every_repeat_improves_legacy_5pct === true,
  };
}

function isPolicyJudgeEligible(replay) {
  return Object.values(deterministicPolicyGate(replay)).every(Boolean);
}

async function evolveBlockPolicy(options) {
  const repoRoot = path.resolve(options.repoRoot || path.resolve(RESEARCH_ROOT, ".."));
  const corpusPath = path.resolve(options.corpusPath);
  const outPath = path.resolve(options.outPath);
  const rounds = Math.max(1, Math.min(3, positiveInteger(options.rounds, 3)));
  const trainingRecords = await loadPolicyRecords(corpusPath, {
    split: "train",
    limit: options.trainingRecords || 500,
    minOutputChars: options.minOutputChars || 200,
    seed: options.seed,
    rulesPath: path.join(repoRoot, "rules", "default-rules.json"),
  });
  const samples = buildTrainingBlockSamples(trainingRecords, {
    limit: options.generatorSamples || 32,
    maxBlockChars: options.maxSampleChars || 4000,
    maxTotalChars: options.maxPromptChars || 120000,
    seed: options.seed,
  });
  const configuration = {
    generator_model: options.generatorModel || DEFAULT_GENERATOR_MODEL,
    generator_effort: options.generatorEffort || DEFAULT_GENERATOR_EFFORT,
    judge_model: options.judgeModel || DEFAULT_JUDGE_MODEL,
    judge_effort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
    max_rounds: rounds,
    baseline_commit: options.baselineCommit || "7830b17",
    repetitions: positiveInteger(options.repetitions, 3),
    validation_records_per_repeat: positiveInteger(options.validationSamples, 300),
    training_records: positiveInteger(options.trainingRecords, 500),
    generator_samples: positiveInteger(options.generatorSamples, 32),
    minimum_output_chars: positiveInteger(options.minOutputChars, 200),
    seed: String(options.seed || "20260729"),
    remote_block_sample_count: samples.length,
    remote_block_sample_sha256: digest(JSON.stringify(samples)),
    full_trajectories_uploaded: false,
  };
  const state = options.resumeStatePath
    ? resumeEvolutionState(options.resumeStatePath, configuration, options.dryRun)
    : {
    schema_version: 1,
    kind: "block-policy-evolution",
    status: options.dryRun ? "planned" : "running",
    configuration,
    rounds: [],
    frozen: [],
    validation_accepted: [],
    accepted: [],
  };
  const completedRounds = state.rounds.reduce(
    (maximum, round) => Math.max(maximum, positiveInteger(round && round.round, 0)),
    0
  );
  const startRound = completedRounds + 1;
  if (startRound > rounds) {
    throw new Error(
      `Resume state already completed ${completedRounds} round(s); --rounds must be at least ${startRound}`
    );
  }
  writeJson(outPath, state);
  if (options.dryRun) return state;
  if (!samples.length) throw new Error("No bounded general-command blocks were available for policy evolution");

  const generatorTemplate = fs.readFileSync(
    path.join(RESEARCH_ROOT, "prompts", "generate-block-policy.md"),
    "utf8"
  );
  const generatorSchema = path.join(RESEARCH_ROOT, "schemas", "block-policy-candidates.schema.json");
  for (let roundNumber = startRound; roundNumber <= rounds; roundNumber += 1) {
    const generated = runCodexStructured({
      codexBin: options.codexBin,
      cwd: repoRoot,
      model: options.generatorModel || DEFAULT_GENERATOR_MODEL,
      effort: options.generatorEffort || DEFAULT_GENERATOR_EFFORT,
      schemaPath: generatorSchema,
      prompt: `${generatorTemplate}\n\nINPUT JSON:\n${JSON.stringify({
        round: roundNumber,
        frozen_failures: state.frozen.slice(-12),
        blocks: samples,
      })}`,
      maxPromptChars: options.maxPromptChars || 200000,
      timeoutMs: options.timeoutMs,
    });
    const candidates = Array.isArray(generated.candidates) ? generated.candidates : [];
    const evaluated = [];
    for (const rawCandidate of candidates) {
      const validation = validatePolicyCandidate(rawCandidate);
      const replay = validation.valid
        ? await replayBlockPolicy({
          ...options,
          repoRoot,
          corpusPath,
          candidate: validation.candidate,
          split: "validation",
          limit: options.validationSamples || 300,
          repetitions: options.repetitions || 3,
        })
        : {
          policy_id: validation.candidate.policy_id,
          repeats: [invalidMetrics(validation.errors)],
          aggregate: aggregatePolicyMetrics([invalidMetrics(validation.errors)]),
        };
      evaluated.push({ candidate: validation.candidate, replay });
    }
    const verdicts = judgeBlockPolicies(evaluated, {
      codexBin: options.codexBin,
      cwd: repoRoot,
      judgeModel: options.judgeModel || DEFAULT_JUDGE_MODEL,
      judgeEffort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
      maxPromptChars: options.maxPromptChars,
      timeoutMs: options.timeoutMs,
    });
    const verdictById = new Map(verdicts.map((entry) => [entry.policy_id, entry]));
    const round = { round: roundNumber, generated: candidates.length, evaluated: [] };
    for (const entry of evaluated) {
      const judge = verdictById.get(entry.candidate.policy_id) || {};
      const gate = {
        ...deterministicPolicyGate(entry.replay),
        held_out_ai_pass_99pct: judge.approved === true && Number(judge.pass_rate) >= 0.99,
      };
      const accepted = Object.values(gate).every(Boolean);
      const result = { ...entry, judge, gate, accepted };
      round.evaluated.push(result);
      if (accepted) {
        state.validation_accepted.push(result);
      } else {
        state.frozen.push({
          policy_id: entry.candidate.policy_id,
          candidate: withoutResearchFields(entry.candidate),
          complaints: policyComplaints(result),
        });
      }
    }
    state.rounds.push(round);
    writeJson(outPath, state);
    if (state.validation_accepted.length) break;
  }
  state.status = state.validation_accepted.length ? "validation-accepted" : "no-policy-passed";
  writeJson(outPath, state);
  return state;
}

function resumeEvolutionState(pathname, configuration, dryRun) {
  const resumePath = path.resolve(pathname);
  const previous = JSON.parse(fs.readFileSync(resumePath, "utf8"));
  if (previous.kind !== "block-policy-evolution") {
    throw new Error(`Resume state is not a block-policy evolution: ${resumePath}`);
  }
  if ((previous.validation_accepted || []).length || (previous.accepted || []).length) {
    throw new Error("Resume state already has an accepted policy; run policy-finalize instead");
  }
  const previousConfiguration = objectValue(previous.configuration);
  for (const field of [
    "generator_model",
    "generator_effort",
    "judge_model",
    "judge_effort",
    "baseline_commit",
    "training_records",
    "generator_samples",
    "minimum_output_chars",
    "seed",
    "remote_block_sample_sha256",
  ]) {
    if (
      previousConfiguration[field] != null &&
      String(previousConfiguration[field]) !== String(configuration[field])
    ) {
      throw new Error(
        `Resume configuration mismatch for ${field}: ` +
        `${previousConfiguration[field]} != ${configuration[field]}`
      );
    }
  }
  if (
    previousConfiguration.remote_block_sample_count != null &&
    Number(previousConfiguration.remote_block_sample_count) !==
      Number(configuration.remote_block_sample_count)
  ) {
    throw new Error(
      "Resume block sample count changed; use the same --generator-samples and corpus"
    );
  }
  return {
    ...previous,
    schema_version: 1,
    kind: "block-policy-evolution",
    status: dryRun ? "planned" : "running",
    configuration: {
      ...previousConfiguration,
      ...configuration,
    },
    rounds: Array.isArray(previous.rounds) ? previous.rounds : [],
    frozen: Array.isArray(previous.frozen) ? previous.frozen : [],
    validation_accepted: [],
    accepted: [],
    resumed_from: resumePath,
  };
}

function judgeBlockPolicies(evaluated, options = {}) {
  const eligible = evaluated.filter((entry) => isPolicyJudgeEligible(entry.replay));
  if (!eligible.length) return [];
  const template = fs.readFileSync(
    path.join(RESEARCH_ROOT, "prompts", "judge-block-policy.md"),
    "utf8"
  );
  const payload = {
    policies: eligible.map((entry) => ({
      candidate: withoutResearchFields(entry.candidate),
      deterministic_metrics: entry.replay.aggregate,
      repeats: entry.replay.repeats.map((repeat) => ({
        repetition: repeat.repetition,
        eligible_records: repeat.eligible_records,
        incremental_token_reduction: repeat.incremental_token_reduction,
        critical_fact_retention: repeat.critical_fact_retention,
        protected_block_retention: repeat.protected_block_retention,
        examples: (repeat.examples || []).slice(0, 2),
        loss_examples: (repeat.loss_examples || []).slice(0, 2),
      })),
    })),
  };
  const result = runCodexStructured({
    codexBin: options.codexBin,
    cwd: options.cwd || path.resolve(RESEARCH_ROOT, ".."),
    model: options.judgeModel || DEFAULT_JUDGE_MODEL,
    effort: options.judgeEffort || DEFAULT_JUDGE_EFFORT,
    schemaPath: path.join(RESEARCH_ROOT, "schemas", "block-policy-judge.schema.json"),
    prompt: `${template}\n\nINPUT JSON:\n${JSON.stringify(payload)}`,
    maxPromptChars: options.maxPromptChars || 200000,
    timeoutMs: options.timeoutMs,
  });
  return Array.isArray(result.verdicts) ? result.verdicts : [];
}

async function finalizeBlockPolicy(state, options = {}) {
  const evaluations = [];
  if (state.evaluated) evaluations.push(state.evaluated);
  for (const entry of state.validation_accepted || []) evaluations.push(entry);
  for (const round of state.rounds || []) {
    for (const entry of round.evaluated || []) if (entry.accepted) evaluations.push(entry);
  }
  const unique = Array.from(new Map(
    evaluations.map((entry) => [entry.candidate && entry.candidate.policy_id, entry])
  ).values()).filter((entry) => entry.candidate);
  const validation = options.policyId
    ? unique.find((entry) => entry.candidate.policy_id === options.policyId)
    : unique.length === 1 ? unique[0] : null;
  if (!validation) {
    throw new Error(options.policyId
      ? `Validation-accepted policy ${options.policyId} was not found`
      : `Expected exactly one validation-accepted policy, found ${unique.length}`);
  }
  if (!validation.accepted || !validation.gate || Object.values(validation.gate).some((value) => value !== true)) {
    throw new Error(`Policy ${validation.candidate.policy_id} has not passed the validation and judge gates`);
  }
  const testReplay = await replayBlockPolicy({
    ...options,
    candidate: validation.candidate,
    split: "test",
  });
  const testGate = deterministicPolicyGate(testReplay);
  const accepted = Object.values(testGate).every(Boolean);
  const evaluated = {
    ...validation,
    test_replay: testReplay,
    test_gate: testGate,
    test_complaints: replayComplaints(testReplay, testGate),
    accepted,
  };
  return {
    schema_version: 1,
    kind: "block-policy-final-evaluation",
    status: accepted ? "accepted" : "test-rejected",
    configuration: {
      ...(state.configuration || {}),
      test_split: "test",
      test_repetitions: options.repetitions || 3,
      test_records_per_repeat: options.limit || 300,
    },
    evaluated,
    accepted: accepted ? [evaluated] : [],
  };
}

function promoteBlockPolicy(statePath, rulesPath, outPath = rulesPath, provenanceOverrides = {}) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const accepted = Array.isArray(state.accepted) ? state.accepted : [];
  if (!accepted.length) throw new Error("No accepted block policy is available for promotion");
  const entry = accepted[0];
  if (!entry.gate || Object.values(entry.gate).some((value) => value !== true)) {
    throw new Error(`Policy ${entry.candidate && entry.candidate.policy_id} has not passed every validation gate`);
  }
  if (!entry.test_gate || Object.values(entry.test_gate).some((value) => value !== true)) {
    throw new Error(`Policy ${entry.candidate && entry.candidate.policy_id} has not passed every test gate`);
  }
  const validation = validatePolicyCandidate(entry.candidate);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  applyCandidateToRules(rules, validation.candidate, "accepted", {
    generator_model: state.configuration && state.configuration.generator_model,
    generator_effort: state.configuration && state.configuration.generator_effort,
    judge_model: state.configuration && state.configuration.judge_model,
    judge_effort: state.configuration && state.configuration.judge_effort,
    baseline_commit: state.configuration && state.configuration.baseline_commit,
    ...objectValue(provenanceOverrides),
  });
  writeJson(outPath, rules);
  return {
    promoted: validation.candidate.policy_id,
    outPath: path.resolve(outPath),
  };
}

function applyCandidateToRules(rules, input, status, provenance = {}) {
  const candidate = normalizeCandidate(input);
  rules.version = Math.max(3, Number(rules.version || 1));
  rules.block_policy = {
    provenance: {
      status,
      policy_id: candidate.policy_id,
      dataset_promotion_required: status !== "accepted",
      ...objectValue(provenance),
    },
    default_tier: candidate.default_tier,
    opaque_encoded: candidate.opaque_encoded,
    dense_semantic: candidate.dense_semantic,
    visual: candidate.visual,
    signals: candidate.signals.map((signal) => {
      const output = { id: signal.id, tier: signal.tier };
      if (signal.kind) output.kind = signal.kind;
      if (signal.pattern) output.pattern = signal.pattern;
      if (signal.flags) output.flags = signal.flags;
      return output;
    }),
  };
  rules.planner = candidate.planner;
  return rules;
}

function requirePreservePattern(candidate, id, sentinels, errors) {
  const signal = candidate.signals.find((entry) => entry.id === id);
  if (!signal || signal.tier !== "preserve" || !signal.pattern) {
    errors.push(`${id} must remain a preserve regex signal`);
    return;
  }
  let expression;
  try {
    expression = new RegExp(signal.pattern, signal.flags || "i");
  } catch {
    return;
  }
  for (const sentinel of sentinels) {
    expression.lastIndex = 0;
    if (!expression.test(sentinel)) errors.push(`${id} must match ${sentinel}`);
  }
}

function validateStrategy(value, label, errors) {
  const strategy = objectValue(value);
  validateIntegerRange(strategy.keep_first_n, 1, 100, `${label}.keep_first_n`, errors);
  validateIntegerRange(strategy.keep_last_n, 1, 100, `${label}.keep_last_n`, errors);
  validateIntegerRange(strategy.max_lines, 10, 300, `${label}.max_lines`, errors);
  if (
    Number.isInteger(strategy.keep_first_n) &&
    Number.isInteger(strategy.keep_last_n) &&
    Number.isInteger(strategy.max_lines) &&
    strategy.keep_first_n + strategy.keep_last_n > strategy.max_lines
  ) {
    errors.push(`${label} head and tail must fit within max_lines`);
  }
}

function validStrategy(value) {
  const strategy = objectValue(value);
  return ["keep_first_n", "keep_last_n", "max_lines"].every((field) =>
    Number.isInteger(strategy[field])
  );
}

function validateIntegerRange(value, minimum, maximum, label, errors) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be an integer in [${minimum},${maximum}]`);
  }
}

function validateNumberRange(value, minimum, maximum, label, errors) {
  if (!Number.isFinite(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
    errors.push(`${label} must be in [${minimum},${maximum}]`);
  }
}

function isProtectedBlock(block, candidate) {
  return isOpaqueEncodedBlock(block.lines, candidate.opaque_encoded) ||
    isDenseSemanticBlock(block.lines, candidate.dense_semantic) ||
    isVisualStructureBlock(block.lines, candidate.visual);
}

function criticalLinesForOutput(lines) {
  const criticalIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isCriticalFactLine(lines[index])) criticalIndexes.push(index);
  }
  return lines.filter((line, index) => {
    if (isCriticalFactLine(line)) return true;
    if (!isCriticalContextLine(line)) return false;
    if (!/^\s*>\s+/.test(line)) return true;
    return criticalIndexes.some((criticalIndex) => Math.abs(criticalIndex - index) <= 2);
  });
}

function isCriticalFactLine(line) {
  const text = String(line || "");
  const realTimeout = /(?:\btimed?\s+out\b|\bTimeout(?:Error|Exception)\b|\b(?:command|connection|operation|request|test)\b[^\n]{0,80}\btimeout\b)/i;
  if (realTimeout.test(text)) return true;
  if (!isCriticalLine(text)) return false;
  if (!/\btimeout\b/i.test(text)) return true;
  const withoutTimeout = text.replace(/\btimeout\b/gi, "");
  if (isCriticalLine(withoutTimeout)) return true;
  return false;
}

function hasSyntheticDiagnostics(text) {
  return /^(?:\[compression plan\]|\[block \d+\b.*(?:importance|score|tier)=)/im.test(String(text || ""));
}

function observationFromRecord(record) {
  return {
    command: String(record.command || ""),
    stdout: String(record.stdout || ""),
    stderr: String(record.stderr || ""),
    exitCode: record.exit_code == null ? null : Number(record.exit_code),
    agent: "research",
    toolName: "Bash",
  };
}

function tierCounts(blocks) {
  const counts = { preserve: 0, light: 0, aggressive: 0 };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (Object.prototype.hasOwnProperty.call(counts, block.tier)) counts[block.tier] += 1;
  }
  return counts;
}

function invalidMetrics(errors) {
  return {
    valid: false,
    validation_errors: errors,
    eligible_records: 0,
    changed_records: 0,
    raw_token_reduction: 0,
    incremental_token_reduction: 0,
    critical_fact_retention: 0,
    protected_block_retention: 0,
    model_visible_diagnostic_outputs: 0,
    examples: [],
  };
}

function policyComplaints(entry) {
  const complaints = [];
  for (const repeat of entry.replay.repeats || []) {
    complaints.push(...(repeat.validation_errors || []));
  }
  for (const [gate, passed] of Object.entries(entry.gate || {})) {
    if (!passed) complaints.push(`Failed gate: ${gate}`);
  }
  if (entry.judge && Array.isArray(entry.judge.complaints)) {
    complaints.push(...entry.judge.complaints);
  }
  complaints.push(...replayComplaints(entry.replay, entry.gate));
  return Array.from(new Set(complaints));
}

function replayComplaints(replay, gate) {
  const complaints = [];
  if (gate && gate.every_repeat_incremental_reduction_5pct === false) {
    const aggregate = objectValue(replay && replay.aggregate);
    complaints.push(
      "Compression gate failed: minimum repeat improvement was " +
      `${formatPercent(aggregate.minimum_incremental_token_reduction)}`
    );
    const reasons = Object.entries(objectValue(aggregate.preserve_reason_lines))
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 4)
      .map(([id, lines]) => `${id}=${lines}`)
      .join(", ");
    if (reasons) complaints.push(`Largest preserve-signal line counts: ${reasons}`);
    const worstSources = (replay.repeats || []).flatMap((repeat) =>
      Object.entries(objectValue(repeat.by_source)).map(([source, metrics]) => ({
        source,
        reduction: Number(metrics.incremental_token_reduction || 0),
      }))
    ).sort((left, right) => left.reduction - right.reduction).slice(0, 3);
    if (worstSources.length) {
      complaints.push(
        "Worst source/repeat reductions: " +
        worstSources.map((entry) =>
          `${entry.source}=${formatPercent(entry.reduction)}`
        ).join(", ")
      );
    }
  }
  return complaints;
}

function observePlanDiagnostics(plan, totals) {
  for (const block of (plan && plan.blocks) || []) {
    const lines = Math.max(0, Number(block.endLine) - Number(block.startLine) + 1);
    incrementCount(totals.tierLines, block.tier, lines);
    incrementCount(totals.tierBlocks, block.tier, 1);
    if (block.tier !== "preserve") continue;
    for (const reason of block.reasons || []) {
      incrementCount(totals.preserveReasonLines, reason.id, lines);
      incrementCount(totals.preserveReasonBlocks, reason.id, 1);
    }
  }
}

function incrementCount(counts, key, value) {
  if (!key) return;
  counts[key] = Number(counts[key] || 0) + Number(value || 0);
}

function mergeCountObjects(values) {
  const counts = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(objectValue(value))) {
      incrementCount(counts, key, count);
    }
  }
  return sortCountObject(counts);
}

function sortCountObject(value) {
  return Object.fromEntries(
    Object.entries(objectValue(value)).sort((left, right) =>
      Number(right[1]) - Number(left[1]) || left[0].localeCompare(right[0])
    )
  );
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function withoutResearchFields(input) {
  const candidate = normalizeCandidate(input);
  delete candidate.rationale;
  delete candidate.confidence;
  return candidate;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value == null ? "" : value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
  aggregatePolicyMetrics,
  applyCandidateToRules,
  buildTrainingBlockSamples,
  candidateFromRules,
  criticalLinesForOutput,
  deterministicPolicyGate,
  evaluatePolicyAgainstLegacy,
  evolveBlockPolicy,
  finalizeBlockPolicy,
  isPolicyJudgeEligible,
  isCriticalFactLine,
  judgeBlockPolicies,
  loadPolicyRecords,
  normalizeCandidate,
  promoteBlockPolicy,
  replayBlockPolicy,
  validatePolicyCandidate,
  withoutResearchFields,
};
