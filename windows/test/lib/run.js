// Runs the tests of one file in order; prints "passed: <name>" per test, exits 1 on any failure.
'use strict';

async function runTests(tests) {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`passed: ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAILED: ${name}\n${e.stack || e}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { runTests };
