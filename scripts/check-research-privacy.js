"use strict";

const { execFileSync } = require("node:child_process");

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const privateDirectories = new Set([
  "artifacts",
  "captures",
  "data",
  "jobs",
  "private",
  "raw",
  "rollouts",
  "sessions",
  "trajectories",
]);

const privateExtensions = new Set([
  ".har",
  ".jsonl",
  ".log",
  ".ndjson",
  ".sqlite",
  ".sqlite3",
]);

function isPrivateResearchPath(file) {
  if (!file.startsWith("research/")) return false;

  const segments = file.split("/");
  if (segments.some((segment) => privateDirectories.has(segment))) return true;

  return [...privateExtensions].some((extension) => file.endsWith(extension));
}

const violations = tracked.filter(isPrivateResearchPath);

if (violations.length > 0) {
  console.error("privacy boundary failed: tracked research data found");
  for (const file of violations) console.error(`- ${file}`);
  process.exit(1);
}

console.log("research privacy boundary passed: no tracked trajectory data");
