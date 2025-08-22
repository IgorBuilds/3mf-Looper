const path = require('path');

function printFinal(outputPath, realMb = null, estMb = null) {
  const base = path.basename(outputPath);
  console.log('');
  if (realMb != null && estMb != null) {
    console.log(`✅ Done: ${base}  (Size: ${realMb}mb) (Estimate: ${estMb}mb)`);
  } else {
    console.log(`✅ Done: ${base}`);
  }
  console.log('');
  console.log(`💾 File:  "${outputPath}"`);
}

module.exports = { printFinal };


