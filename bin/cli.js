#!/usr/bin/env node
const { run } = require('../src/index');

(async () => {
  try {
    await run(process.argv.slice(2));
  } catch (err) {
    console.error('[error]', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
})();


