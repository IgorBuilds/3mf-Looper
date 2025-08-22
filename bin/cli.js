#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { once } = require('events');
const readline = require('readline');
const unzipper = require('unzipper');
const archiver = require('archiver');
const { run } = require('../src/index');
const prompts = require('prompts');

async function main() {
  const argv = process.argv.slice(2);
  try {
    await run(argv);
    return;
  } catch (err) {
    console.error('[error]', err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
  // Legacy code below (unreachable after refactor)
  const [loopArg, ...rawArgs] = process.argv.slice(2);

  if (!loopArg || rawArgs.length === 0) {
    printUsageAndExit('Missing arguments.');
  }
  const loopSpec = parseLoopSpecifier(loopArg);
  
  const flagArgs = rawArgs.filter((a) => a.startsWith('--'));
  const fileArgs = rawArgs.filter((a) => !a.startsWith('--'));
  const flagSet = new Set(flagArgs);
  const flags = {
    allGcodes: flagSet.has('--all-gcodes'),
    firstGcode: flagSet.has('--first-gcode'),
  };
  if (flags.allGcodes && flags.firstGcode) {
    printUsageAndExit('Use only one of --all-gcodes or --first-gcode.');
  }

  const inputPaths = fileArgs.map((p) => path.resolve(process.cwd(), p));
  const inputStats = [];
  for (const p of inputPaths) {
    const st = await safeStat(p);
    if (!st || !st.isFile()) {
      printUsageAndExit(`Input path does not exist or is not a file: ${p}`);
    }
    inputStats.push(st);
  }

  const firstInputPath = inputPaths[0];
  const { dir: inputDir, name: inputBaseName, ext: inputExt } = path.parse(firstInputPath);
  if (inputExt.toLowerCase() !== '.3mf') {
    console.warn('[warn] First input does not have .3mf extension; proceeding anyway.');
  }

  console.log(`🚀 Starting 3mf-gcode-looper`);
  if (loopSpec.type === 'count') {
    console.log(`   • Repetitions (requested): ${loopSpec.value}`);
  } else if (loopSpec.type === 'time') {
    console.log(`   • Target time: ${formatDuration(loopSpec.minutes)} (${loopSpec.raw})`);
  } else if (loopSpec.type === 'grams') {
    console.log(`   • Target filament: ${loopSpec.grams} g (${loopSpec.raw})`);
  }
  console.log(`   • Inputs (${inputPaths.length}):`);
  inputPaths.forEach((p, i) => {
    console.log(`     ${i + 1}. ${p}  (${(inputStats[i].size / (1024*1024)).toFixed(2)} MB)`);
  });

  // Size warning (100MB) per file
  const hundredMB = 100 * 1024 * 1024;
  for (let i = 0; i < inputPaths.length; i += 1) {
    if (inputStats[i].size > hundredMB) {
      const YELLOW = '\x1b[33m';
      const BOLD = '\x1b[1m';
      const RESET = '\x1b[0m';
      console.warn(`${BOLD}${YELLOW}WARNING:${RESET} Input ${i + 1} is ${(inputStats[i].size / (1024*1024)).toFixed(1)} MB (> 100 MB). Proceeding...`);
    }
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcode-3mf-looper-'));

  try {
    // 1) Extract each .3mf (zip) into its own temp subdirectory
    const extractedDirs = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      const subdir = path.join(tempRoot, `input-${i + 1}`);
      console.log(`📥 Extracting input ${i + 1} to: ${subdir}`);
      await extractZipToDir(inputPaths[i], subdir);
      extractedDirs.push(subdir);
    }

    // 2) Discover top-level GCODE entries inside each zip (preserving zip order)
    const gcodeNameCandidatesPerInput = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      const names = await listTopLevelGcodesInZip(inputPaths[i]);
      if (names.length === 0) {
        throw new Error(`No top-level metadata/*.gcode found in input ${i + 1}.`);
      }
      console.log(`🧾 Input ${i + 1} GCODE candidates: ${names.join(', ')}`);
      gcodeNameCandidatesPerInput.push(names);
    }

    // 3) Choose which GCODE(s) per input
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const selectedNamesPerInput = [];
    for (let i = 0; i < gcodeNameCandidatesPerInput.length; i += 1) {
      const candidates = gcodeNameCandidatesPerInput[i];
      if (candidates.length === 1) {
        selectedNamesPerInput.push(candidates);
        continue;
      }
      if (flags.allGcodes) {
        selectedNamesPerInput.push(candidates);
        continue;
      }
      if (flags.firstGcode) {
        selectedNamesPerInput.push([candidates[0]]);
        continue;
      }
      if (!isInteractive) {
        throw new Error(`Input ${i + 1} has ${candidates.length} GCODEs. Run interactively or pass --all-gcodes or --first-gcode.`);
      }
      const res = await prompts({
        type: 'multiselect',
        name: 'files',
        message: `Select GCODE(s) for ${path.basename(inputPaths[i])} (Space to toggle, Enter to confirm)`,
        choices: [
          { title: 'All (every .gcode)', value: '*ALL*' },
          ...candidates.map((n) => ({ title: n, value: n })),
        ],
        hint: 'Use arrows/space to select; order will match zip order',
        min: 1,
      });
      if (!res || !res.files) {
        throw new Error('Selection cancelled.');
      }
      const values = Array.isArray(res.files) ? res.files : [res.files];
      const final = values.includes('*ALL*') ? candidates : candidates.filter((n) => values.includes(n));
      if (final.length === 0) {
        throw new Error('No GCODE selected.');
      }
      selectedNamesPerInput.push(final);
    }

    // 4) Locate metadata directory in each extracted dir
    const metadataDirs = [];
    for (let i = 0; i < extractedDirs.length; i += 1) {
      const md = await findMetadataDirectory(extractedDirs[i]);
      if (!md) {
        throw new Error(`Could not find a metadata directory in input ${i + 1}.`);
      }
      console.log(`🧭 Input ${i + 1} metadata: ${md}`);
      metadataDirs.push(md);
    }

    // 5) Build the list of extracted GCODE paths in the chosen order
    const gcodePaths = [];
    const displayNames = [];
    for (let i = 0; i < selectedNamesPerInput.length; i += 1) {
      const md = metadataDirs[i];
      for (const name of selectedNamesPerInput[i]) {
        gcodePaths.push(path.join(md, name));
        displayNames.push(name);
      }
    }

    // 3b) Analyze each gcode for time (M73 P0 R{minutes}) and filament grams
    console.log('🧮 Analyzing print times and filament usage...');
    const analyses = [];
    for (let i = 0; i < gcodePaths.length; i += 1) {
      const a = await analyzeGcodeFile(gcodePaths[i]);
      analyses.push(a);
      console.log(`   • Input ${i + 1}: ${a.minutes} min, ${a.grams.toFixed(2)} g`);
    }
    const perLoopMinutes = analyses.reduce((sum, a) => sum + (a.minutes || 0), 0);
    const perLoopGrams = analyses.reduce((sum, a) => sum + (a.grams || 0), 0);
    if (perLoopMinutes <= 0) {
      console.warn('[warn] Computed per-loop minutes is 0; time-based targets will fail.');
    }
    if (perLoopGrams <= 0) {
      console.warn('[warn] Computed per-loop grams is 0; gram-based targets will fail.');
    }

    // Decide repetitions from loopSpec
    let repetitions;
    if (loopSpec.type === 'count') {
      repetitions = loopSpec.value;
    } else if (loopSpec.type === 'time') {
      if (perLoopMinutes <= 0) {
        throw new Error('Per-loop time is 0, cannot compute loops from time target.');
      }
      repetitions = Math.floor(loopSpec.minutes / perLoopMinutes);
    } else if (loopSpec.type === 'grams') {
      if (perLoopGrams <= 0) {
        throw new Error('Per-loop filament is 0, cannot compute loops from grams target.');
      }
      repetitions = Math.floor(loopSpec.grams / perLoopGrams);
    }
    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error(`Target yields 0 loops (per loop: ${perLoopMinutes} min, ${perLoopGrams.toFixed(2)} g). Increase target or add files.`);
    }
    console.log(`   • Repetitions (computed): ${repetitions}`);

    const totalMinutes = perLoopMinutes * repetitions;
    const totalGrams = Math.ceil(perLoopGrams * repetitions);
    const durationLabel = formatDuration(totalMinutes);
    console.log(`   = Per loop: ${perLoopMinutes} min, ${perLoopGrams.toFixed(2)} g`);
    console.log(`   = TOTAL (${repetitions}x): ${totalMinutes} min (${durationLabel}), ${totalGrams} g`);

    // 6) Build repeated sequence into the FIRST input's gcode
    const workingDir = extractedDirs[0];
    const firstGcodePath = gcodePaths[0];
    const tmpGcodePath = firstGcodePath + '.tmp';
    console.log(`🔁 Writing combined G-code from ${gcodePaths.length} GCODE(s) × ${repetitions} loop(s)...`);
    await streamRepeatFiles(gcodePaths, tmpGcodePath, repetitions, displayNames);
    await fsp.rename(tmpGcodePath, firstGcodePath);
    console.log(`✅ G-code updated in first input.`);

    // 5) Re-zip the FIRST input's folder to output filename next to first input
    const coreName = inputBaseName.replace(/\.gcode$/i, '');
    const outputName = `Loop X ${repetitions} - ${durationLabel} - ${totalGrams}g - ${coreName}.gcode.3mf`;
    const outputPath = path.join(inputDir, outputName);
    console.log(`🗜️  Creating archive: ${outputPath}`);
    await zipDirectoryContents(workingDir, outputPath);

    const outputBase = path.basename(outputPath);
    console.log(``);
    console.log(`✅ Done: ${outputBase}`);
    console.log(``);
    console.log(`💾 File:  "${outputPath}"`);
  } catch (err) {
    console.error('[error]', err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  } finally {
    // Cleanup temp dir
    await safeRm(tempRoot);
  }
}

function printUsageAndExit(msg) {
  if (msg) console.error('[error]', msg);
  console.error('Usage: 3mf-gcode-looper <count|time|grams> <file1.3mf> [file2.3mf ...]');
  console.error('  • count: positive integer (e.g., 5)');
  console.error('  • time:  number with unit m/h/d (e.g., 120m, 2h, 1d)');
  console.error('  • grams: number with unit g (e.g., 100g)');
  process.exit(1);
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function safeRm(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch {}
}

async function extractZipToDir(zipFilePath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(zipFilePath);
    const extractor = unzipper.Extract({ path: destDir });
    rs.on('error', reject);
    extractor.on('error', reject);
    extractor.on('close', resolve);
    rs.pipe(extractor);
  });
}

async function findMetadataDirectory(rootDir) {
  const candidate = path.join(rootDir, 'metadata');
  const st = await safeStat(candidate);
  if (st && st.isDirectory()) return candidate;
  return null;
}

// List top-level metadata/*.gcode names preserving zip order: we will read from the zip directly
async function listTopLevelGcodesInZip(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const names = [];
  for (const entry of directory.files) {
    if (entry.type !== 'File' || !entry.path) continue;
    // Normalize path
    let p = entry.path.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('/')) p = p.slice(1);
    const segments = p.split('/');
    if (segments.length !== 2) continue; // ensure exactly metadata/<file>
    const [first, second] = segments;
    if (first.toLowerCase() !== 'metadata') continue;
    if (!second.toLowerCase().endsWith('.gcode')) continue;
    names.push(second);
  }
  return names;
}

async function streamRepeatFile(sourcePath, destPath, times) {
  const ws = fs.createWriteStream(destPath);
  ws.on('error', (e) => {
    throw e;
  });

  const header = `; File modificated at ${formatDateTime(new Date())} for ${times} loops`;
  await writeString(ws, header + "\n");

  for (let i = 1; i <= times; i += 1) {
    if (i > 1) {
      await writeString(ws, `; Starting loop ${i}\n`);
    }
    await writeString(ws, `; Starting loop ${i} for "${path.basename(sourcePath)}"\n`);
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(sourcePath);
      rs.on('error', reject);
      rs.on('end', resolve);
      rs.pipe(ws, { end: false });
    });
  }

  const footer = header;
  await writeString(ws, "\n" + footer + "\n");

  ws.end();
  await once(ws, 'finish');
}

// Multi-source version: concatenate all sources in order per loop
async function streamRepeatFiles(sourcePaths, destPath, times, fileDisplayNames = []) {
  const ws = fs.createWriteStream(destPath);
  ws.on('error', (e) => {
    throw e;
  });

  const names = fileDisplayNames.length ? fileDisplayNames.join(', ') : sourcePaths.map((p) => path.basename(p)).join(', ');
  const header = `; File modificated at ${formatDateTime(new Date())} for ${times} loops for files: ${names}`;
  await writeString(ws, header + "\n");

  for (let i = 1; i <= times; i += 1) {
    if (i > 1) {
      await writeString(ws, `; Starting loop ${i}\n`);
    }
    for (let s = 0; s < sourcePaths.length; s += 1) {
      const displayName = fileDisplayNames[s] || path.basename(sourcePaths[s]);
      await writeString(ws, `; Starting loop ${i} for "${displayName}"\n`);
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
}

async function writeString(ws, str) {
  return new Promise((resolve, reject) => {
    const ok = ws.write(str, (err) => (err ? reject(err) : resolve()));
    if (!ok) {
      ws.once('drain', resolve);
    }
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

async function zipDirectoryContents(sourceDir, outZipPath) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn('[warn]', err.message);
      } else {
        reject(err);
      }
    });
    archive.on('error', reject);

    archive.pipe(output);
    // Add directory contents at zip root (no wrapping folder)
    archive.directory(sourceDir + '/', false);
    archive.finalize();
  });
}

// Analyze a gcode file for M73 time (minutes) and filament grams
async function analyzeGcodeFile(filePath) {
  // We scan once for time (any line like: M73 P0 R22) and the last filament line
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

function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

function parseLoopSpecifier(arg) {
  const raw = String(arg);
  // integer count
  if (/^\d+$/.test(raw)) {
    const value = parseInt(raw, 10);
    if (value >= 1) return { type: 'count', value, raw };
  }
  // time: m/h/d
  const timeMatch = raw.match(/^(\d+(?:\.\d+)?)([mhd])$/i);
  if (timeMatch) {
    const qty = parseFloat(timeMatch[1]);
    const unit = timeMatch[2].toLowerCase();
    let minutes = qty;
    if (unit === 'h') minutes = qty * 60;
    if (unit === 'd') minutes = qty * 60 * 24;
    return { type: 'time', minutes, raw };
  }
  // grams: g
  const gMatch = raw.match(/^(\d+(?:\.\d+)?)g$/i);
  if (gMatch) {
    const grams = parseFloat(gMatch[1]);
    return { type: 'grams', grams, raw };
  }
  printUsageAndExit('Invalid loop specifier.');
}

main();


