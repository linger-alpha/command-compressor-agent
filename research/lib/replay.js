"use strict";

const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { isCriticalLine } = require("../../src/compression/classifiers");
const { compressObservation } = require("../../src/compression/compressor");
const { outputLinesFromObservation } = require("../../src/compression/format");
const { regexTest } = require("../../src/compression/utils");
const { boundedRedacted } = require("./redaction");

function validateCandidate(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { valid: false, errors: ["candidate must be an object"] };
  }
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(String(candidate.rule_id || ""))) {
    errors.push("rule_id must be a stable lowercase identifier");
  }
  for (const field of ["trigger_regex", "output_regex"]) {
    const result = regexSafety(candidate[field]);
    if (!result.safe && String(candidate[field] || "")) errors.push(`${field}: ${result.reason}`);
  }
  for (const field of ["keep_patterns", "strip_patterns"]) {
    if (!Array.isArray(candidate[field])) {
      errors.push(`${field} must be an array`);
      continue;
    }
    for (const pattern of candidate[field]) {
      const result = regexSafety(pattern);
      if (!result.safe) errors.push(`${field}: ${result.reason}`);
    }
  }
  if (!candidate.trigger_regex && !candidate.output_regex) {
    errors.push("at least one trigger regex is required");
  }
  return { valid: errors.length === 0, errors };
}

function regexSafety(value) {
  const pattern = String(value || "");
  if (pattern.length > 500) return { safe: false, reason: "pattern exceeds 500 characters" };
  if (/\\[1-9]/.test(pattern)) return { safe: false, reason: "backreferences are not allowed" };
  if (/\(\?<([=!])/.test(pattern)) return { safe: false, reason: "lookbehind is not allowed" };
  if (/\((?:[^()]|\\.)*[+*](?:[^()]|\\.)*\)[+*{]/.test(pattern)) {
    return { safe: false, reason: "nested unbounded quantifiers are not allowed" };
  }
  try {
    new RegExp(pattern);
  } catch (error) {
    return { safe: false, reason: error.message };
  }
  return { safe: true, reason: "" };
}

function candidateMatches(candidate, record) {
  const command = String(record.command || "");
  const output = `${record.stdout || ""}\n${record.stderr || ""}`;
  const trigger = String(candidate.trigger_regex || "");
  const outputPattern = String(candidate.output_regex || "");
  const commandMatch = trigger ? regexTest(trigger, command, "i") : false;
  const outputMatch = outputPattern ? regexTest(outputPattern, output, "im") : false;
  return trigger && outputPattern ? commandMatch && outputMatch : commandMatch || outputMatch;
}

function evaluateAgainstLegacy(records, candidate, options = {}) {
  const validation = validateCandidate(candidate);
  if (!validation.valid) {
    return {
      valid: false,
      validation_errors: validation.errors,
      applicable_records: 0,
      compressible_records: 0,
      critical_fact_retention: 0,
      incremental_token_reduction: 0,
      examples: [],
    };
  }
  const applicable = records.filter((record) => candidateMatches(candidate, record));
  if (!applicable.length) {
    return {
      valid: true,
      validation_errors: [],
      applicable_records: 0,
      compressible_records: 0,
      critical_fact_retention: 1,
      incremental_token_reduction: 0,
      examples: [],
    };
  }
  return withLegacyBaseline(options.repoRoot || path.resolve(__dirname, "..", ".."), options.baselineCommit || "7830b17", (legacy) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-research-replay-"));
    try {
      const currentRulesPath = path.join(tempDir, "candidate-rules.json");
      const defaultRules = JSON.parse(fs.readFileSync(path.join(options.repoRoot || path.resolve(__dirname, "..", ".."), "rules", "default-rules.json"), "utf8"));
      const key = candidate.category === "strong" ? "strong_rules" : "weak_rules";
      defaultRules[key] = [...(defaultRules[key] || []), { ...candidate, enabled: true }];
      fs.writeFileSync(currentRulesPath, `${JSON.stringify(defaultRules, null, 2)}\n`, "utf8");
      let legacyTokens = 0;
      let currentTokens = 0;
      let criticalTotal = 0;
      let criticalRetained = 0;
      let compressibleRecords = 0;
      const examples = [];

      for (const [index, record] of applicable.entries()) {
        const observation = {
          command: String(record.command || ""),
          stdout: String(record.stdout || ""),
          stderr: String(record.stderr || ""),
          exitCode: record.exit_code == null ? null : Number(record.exit_code),
          agent: "research",
          toolName: "Bash",
        };
        const legacyResult = legacy.compressObservation(observation, {
          strength: options.strength || "xhigh",
          rawDir: path.join(tempDir, "legacy-raw"),
          rulesPath: path.join(legacy.root, "rules", "default-rules.json"),
        });
        const currentResult = compressObservation(observation, {
          strength: options.strength || "xhigh",
          rawDir: path.join(tempDir, "current-raw"),
          rulesPath: currentRulesPath,
        });
        const legacyEffective = legacyResult.changed ? legacyResult.compressedTokensEst : legacyResult.rawTokensEst;
        const currentEffective = currentResult.changed ? currentResult.compressedTokensEst : currentResult.rawTokensEst;
        if (legacyResult.changed || currentResult.changed) {
          compressibleRecords += 1;
          legacyTokens += legacyEffective;
          currentTokens += currentEffective;
        }
        const criticalLines = outputLinesFromObservation(observation).filter((line) => isCriticalLine(line));
        const effectiveText = currentResult.changed
          ? currentResult.text
          : outputLinesFromObservation(observation).join("\n");
        criticalTotal += criticalLines.length;
        criticalRetained += criticalLines.filter((line) => effectiveText.includes(line)).length;
        if (examples.length < Number(options.maxExamples || 8)) {
          const original = boundedRedacted(`${observation.stdout}\n${observation.stderr}`, 4000).text;
          const compressed = boundedRedacted(effectiveText, 4000).text;
          examples.push({
            sample_id: record.id || `sample-${index + 1}`,
            command: boundedRedacted(observation.command, 1000).text,
            original,
            compressed,
            legacy_tokens_est: legacyEffective,
            candidate_tokens_est: currentEffective,
          });
        }
      }
      return {
        valid: true,
        validation_errors: [],
        applicable_records: applicable.length,
        compressible_records: compressibleRecords,
        critical_fact_retention: criticalTotal ? criticalRetained / criticalTotal : 1,
        incremental_token_reduction: legacyTokens
          ? (legacyTokens - currentTokens) / legacyTokens
          : 0,
        legacy_tokens_est: legacyTokens,
        candidate_tokens_est: currentTokens,
        examples,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

function withLegacyBaseline(repoRoot, commit, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cca-legacy-baseline-"));
  const archivePath = path.join(tempDir, "baseline.tar");
  const extractPath = path.join(tempDir, "tree");
  fs.mkdirSync(extractPath);
  try {
    runChecked("git", ["archive", "--format=tar", "-o", archivePath, commit], repoRoot);
    runChecked("tar", ["-xf", archivePath, "-C", extractPath], repoRoot);
    const compressorPath = path.join(extractPath, "src", "compression", "compressor.js");
    const legacy = require(compressorPath);
    return callback({ ...legacy, root: extractPath });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runChecked(command, args, cwd) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error}`);
  }
}

function aggregateReplay(replays, judgeVerdicts = []) {
  const verdicts = new Map(judgeVerdicts.map((verdict) => [verdict.rule_id, verdict]));
  return replays.map((entry) => {
    const verdict = verdicts.get(entry.candidate.rule_id) || {};
    const accepted =
      entry.metrics.valid &&
      entry.metrics.applicable_records > 0 &&
      entry.metrics.critical_fact_retention === 1 &&
      entry.metrics.incremental_token_reduction >= 0.05 &&
      verdict.approved === true &&
      Number(verdict.pass_rate) >= 0.99;
    return {
      ...entry,
      judge: verdict,
      accepted,
      gate: {
        regex_safe: entry.metrics.valid,
        critical_fact_retention_100pct: entry.metrics.critical_fact_retention === 1,
        held_out_ai_pass_99pct: verdict.approved === true && Number(verdict.pass_rate) >= 0.99,
        incremental_token_reduction_5pct: entry.metrics.incremental_token_reduction >= 0.05,
      },
    };
  });
}

module.exports = {
  aggregateReplay,
  candidateMatches,
  evaluateAgainstLegacy,
  regexSafety,
  validateCandidate,
  withLegacyBaseline,
};
