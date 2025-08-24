#!/usr/bin/env node
const { run } = require('../src/index');

(async () => {
  try {
    await run(process.argv.slice(2));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg && msg.toLowerCase().includes('cancel')) {
      console.log('✖ Cancelled by user');
      process.exit(0);
      return;
    }
    console.error('[error]', err && err.stack ? err.stack : msg);
    process.exit(1);
  }
})();


