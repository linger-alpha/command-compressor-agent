"use strict";

const crypto = require("crypto");
const fs = require("fs");
const readline = require("readline");

const { boundedRedacted } = require("./redaction");

async function loadBoundedSamples(corpusPath, options = {}) {
  const split = String(options.split || "train");
  const maxSamples = Number(options.maxSamples || 24);
  const maxSampleChars = Number(options.maxSampleChars || 6000);
  const maxTotalChars = Number(options.maxTotalChars || 120000);
  const minOutputChars = Number(options.minOutputChars || 500);
  const seed = String(options.seed || "20260729");
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
    const sample = {
      id: String(record.id || ""),
      source: String(record.source || ""),
      command: boundedRedacted(record.command, 1000).text,
      output: boundedRedacted(output, maxSampleChars).text,
      exit_code: record.exit_code == null ? null : Number(record.exit_code),
    };
    const key = hash(`${seed}:${sample.id}:${sample.source}`);
    selected.push({ key, sample });
    selected.sort((left, right) => left.key.localeCompare(right.key));
    if (selected.length > maxSamples * 2) selected.length = maxSamples * 2;
  }
  const output = [];
  let totalChars = 0;
  for (const entry of selected) {
    const chars = JSON.stringify(entry.sample).length;
    if (output.length >= maxSamples || totalChars + chars > maxTotalChars) continue;
    output.push(entry.sample);
    totalChars += chars;
  }
  return output;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = {
  loadBoundedSamples,
};
