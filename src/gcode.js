const fs = require('fs');
const { once } = require('events');
const readline = require('readline');
const path = require('path');

async function analyzeGcodeFile(filePath) {
  const rs = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
  const timeRegex = /\bM73\s+P\d+\s+R(\d+)\b/;
  const filamentRegex = /;\s*filament used \[g\]\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s*,\s*([0-9]+(?:\.[0-9]+)?)/i;
  let minutes = null;
  let grams = 0;
  let lastFilamentMatch = null;
  for await (const line of rl) {
    if (minutes === null) {
      const t = line.match(timeRegex);
      if (t) {
        minutes = parseInt(t[1], 10);
      }
    }
    const f = line.match(filamentRegex);
    if (f) {
      lastFilamentMatch = f;
    }
  }
  if (lastFilamentMatch) {
    const vals = lastFilamentMatch.slice(1).map((v) => parseFloat(v) || 0);
    grams = vals.reduce((s, v) => s + v, 0);
  }
  return { minutes: minutes || 0, grams };
}

async function writeString(ws, str) {
  return new Promise((resolve, reject) => {
    const ok = ws.write(str, (err) => (err ? reject(err) : resolve()));
    if (!ok) ws.once('drain', resolve);
  });
}

function formatDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const MM = pad(d.getMinutes());
  const SS = pad(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
}

async function streamRepeatFiles(sourcePaths, destPath, times, fileDisplayNames = []) {
  const ws = fs.createWriteStream(destPath);
  ws.on('error', (e) => { throw e; });

  const names = fileDisplayNames.length ? fileDisplayNames.join(', ') : sourcePaths.map((p) => path.basename(p)).join(', ');
  const header = `; 3mf-looper: File modified at ${formatDateTime(new Date())} for ${times} loops for files: ${names}`;
  await writeString(ws, header + "\n");

  console.log(``);
  console.log(`⏳ Starting file generation`);
  for (let i = 1; i <= times; i += 1) {
    if (i > 1) await writeString(ws, `; 3mf-looper: Starting loop ${i}\n`);
    for (let s = 0; s < sourcePaths.length; s += 1) {
      const displayName = fileDisplayNames[s] || path.basename(sourcePaths[s]);
      await writeString(ws, `; 3mf-looper: Starting loop ${i} for "${displayName}"\n`);
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(sourcePaths[s]);
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
  }

  const footer = header;
  await writeString(ws, "\n" + footer + "\n");
  ws.end();
  await once(ws, 'finish');
  console.log('');
  console.log(`✅ GCODE file looped!`);
  console.log(`📦 Compressing back to .3mf, it may take a while for large files...`);
}

module.exports = {
  analyzeGcodeFile,
  streamRepeatFiles,
  formatDateTime,
};


