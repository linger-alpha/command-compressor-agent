#!/usr/bin/env node
"use strict";

const { main } = require("../src/cli");

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`cca: ${message}\n`);
    process.exitCode = 1;
  }
);
