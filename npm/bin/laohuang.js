#!/usr/bin/env node

const { run } = require("../lib/launcher");

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  console.error(`laohuang: ${error.message}`);
  process.exitCode = 1;
}
