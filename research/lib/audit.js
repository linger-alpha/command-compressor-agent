"use strict";

const fs = require("fs");
const readline = require("readline");

const { redactText } = require("./redaction");

async function auditCorpus(corpusPath, options = {}) {
  const maxFieldChars = Number(options.maxFieldChars || 12000);
  const sessions = new Map();
  const result = {
    ok: true,
    records: 0,
    invalidJson: 0,
    invalidSchema: 0,
    redactionLeaks: 0,
    oversizedFields: 0,
    splitLeaks: 0,
    bySplit: { train: 0, validation: 0, test: 0 },
  };
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
      result.invalidJson += 1;
      continue;
    }
    result.records += 1;
    if (
      record.schema_version !== 1 ||
      !record.id ||
      !record.source ||
      !record.session_id ||
      !["train", "validation", "test"].includes(record.split)
    ) {
      result.invalidSchema += 1;
      continue;
    }
    result.bySplit[record.split] += 1;
    const priorSplit = sessions.get(record.session_id);
    if (priorSplit && priorSplit !== record.split) result.splitLeaks += 1;
    sessions.set(record.session_id, record.split);
    for (const field of ["command", "stdout", "stderr"]) {
      const value = String(record[field] || "");
      if (redactText(value) !== value) result.redactionLeaks += 1;
      const limit = field === "command" ? Number(options.maxCommandChars || 2000) : maxFieldChars;
      if (value.length > limit) result.oversizedFields += 1;
    }
  }
  result.ok =
    result.records > 0 &&
    result.invalidJson === 0 &&
    result.invalidSchema === 0 &&
    result.redactionLeaks === 0 &&
    result.oversizedFields === 0 &&
    result.splitLeaks === 0;
  return result;
}

module.exports = {
  auditCorpus,
};
