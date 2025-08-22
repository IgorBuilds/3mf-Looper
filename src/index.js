const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const prompts = require('prompts');

const { safeStat, safeRm, extractZipToDir, zipDirectoryContents, listTopLevelGcodesInZip, findMetadataDirectory, getTopLevelGcodeSizes } = require('./zip');
const { analyzeGcodeFile, streamRepeatFiles } = require('./gcode');
const { formatDuration, formatMass, parseLoopSpecifier } = require('./compute');
const { promptSelectGcodesForInput } = require('./ui');
const { printFinal } = require('./log');

const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function colorVar(text) {
  return `${BOLD}${CYAN}${text}${RESET}`;
}

async function run(argv) {
  if (!argv || argv.length === 0) {
    return runWizard();
  }
  return runCli(argv);
}

async function runCli(argv) {
  const [loopArg, ...rawArgs] = argv;
  const loopSpec = parseLoopSpecifier(loopArg);
  if (loopSpec.type === 'invalid') {
    throw new Error('Invalid loop specifier. Use a count (e.g., 5), time (e.g., 2h), or grams (e.g., 100g).');
  }

  const flagArgs = rawArgs.filter((a) => a.startsWith('--'));
  const fileArgs = rawArgs.filter((a) => !a.startsWith('--'));
  if (fileArgs.length === 0) {
    throw new Error('Missing .3mf files.');
  }
  const flagSet = new Set(flagArgs);
  const flags = {
    allGcodes: flagSet.has('--all-gcodes'),
    firstGcode: flagSet.has('--first-gcode'),
  };
  if (flags.allGcodes && flags.firstGcode) {
    throw new Error('Use only one of --all-gcodes or --first-gcode.');
  }

  const inputPaths = fileArgs.map((p) => path.resolve(process.cwd(), p));
  const inputStats = [];
  for (const p of inputPaths) {
    const st = await safeStat(p);
    if (!st || !st.isFile()) throw new Error(`Input path does not exist or is not a file: ${p}`);
    inputStats.push(st);
  }

  const firstInputPath = inputPaths[0];
  const { dir: inputDir, name: inputBaseName } = path.parse(firstInputPath);

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
    // 1) Discover top-level GCODE names from zips
    const gcodeNameCandidatesPerInput = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      const names = await listTopLevelGcodesInZip(inputPaths[i]);
      if (names.length === 0) throw new Error(`No top-level metadata/*.gcode found in input ${i + 1}.`);
      gcodeNameCandidatesPerInput.push(names);
    }

    // 2) Selection per input (non-interactive rules)
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
        throw new Error(`Input ${i + 1} has ${candidates.length} GCODEs. Re-run interactively or pass --all-gcodes or --first-gcode.`);
      }
      const chosen = await promptSelectGcodesForInput(inputPaths[i], candidates);
      selectedNamesPerInput.push(chosen);
    }

    // 3) Extract each zip
    const extractedDirs = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      const subdir = path.join(tempRoot, `input-${i + 1}`);
      await extractZipToDir(inputPaths[i], subdir);
      extractedDirs.push(subdir);
    }

    // 4) Resolve metadata dirs and build source paths & display names
    const metadataDirs = [];
    for (let i = 0; i < extractedDirs.length; i += 1) {
      const md = await findMetadataDirectory(extractedDirs[i]);
      if (!md) throw new Error(`Could not find a metadata directory in input ${i + 1}.`);
      metadataDirs.push(md);
    }
    const gcodePaths = [];
    const displayNames = [];
    for (let i = 0; i < selectedNamesPerInput.length; i += 1) {
      for (const name of selectedNamesPerInput[i]) {
        gcodePaths.push(path.join(metadataDirs[i], name));
        displayNames.push(name);
      }
    }

    // 5) Analyze per-loop
    const analyses = [];
    for (let i = 0; i < gcodePaths.length; i += 1) {
      analyses.push(await analyzeGcodeFile(gcodePaths[i]));
    }
    const perLoopMinutes = analyses.reduce((sum, a) => sum + (a.minutes || 0), 0);
    const perLoopGrams = analyses.reduce((sum, a) => sum + (a.grams || 0), 0);

    // 6) Decide repetitions
    let repetitions;
    if (loopSpec.type === 'count') repetitions = loopSpec.value;
    else if (loopSpec.type === 'time') repetitions = Math.floor(loopSpec.minutes / perLoopMinutes || 0);
    else if (loopSpec.type === 'grams') repetitions = Math.floor(loopSpec.grams / perLoopGrams || 0);
    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error(`Target yields 0 loops (per loop: ${perLoopMinutes} min, ${perLoopGrams.toFixed(2)} g). Increase target or add files.`);
    }

    const totalMinutes = perLoopMinutes * repetitions;
    const totalGrams = Math.ceil(perLoopGrams * repetitions);
    const durationLabel = formatDuration(totalMinutes);

    // Size estimation
    const firstZipSize = (await fsp.stat(firstInputPath)).size;
    const sizeMaps = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      sizeMaps.push(await getTopLevelGcodeSizes(inputPaths[i]));
    }
    const estimatedTotalBytes = estimateFinalSize(firstZipSize, sizeMaps, selectedNamesPerInput, repetitions);
    const ONE_GB = 1024 * 1024 * 1024;
    if (estimatedTotalBytes && estimatedTotalBytes > ONE_GB) {
      const cont = await prompts({ type: 'confirm', name: 'ok', message: `Estimated size ~ ${Math.ceil(estimatedTotalBytes / (1024*1024))} MB exceeds 1 GB. Continue?`, initial: false });
      if (!cont || !cont.ok) throw new Error('Cancelled');
    }

    // 7) Write into first input's gcode and rezip
    const workingDir = extractedDirs[0];
    const firstGcodePath = gcodePaths[0];
    const tmpGcodePath = firstGcodePath + '.tmp';
    await streamRepeatFiles(gcodePaths, tmpGcodePath, repetitions, displayNames);
    await fsp.rename(tmpGcodePath, firstGcodePath);

    const coreName = path.parse(firstInputPath).name.replace(/\.gcode$/i, '');
    const outputName = `Loop X ${repetitions} - ${durationLabel} - ${formatMass(totalGrams)} - ${coreName}.gcode.3mf`;
    const outputPath = path.join(inputDir, outputName);
    await zipDirectoryContents(workingDir, outputPath);
    const realSizeBytes = (await fsp.stat(outputPath)).size;
    printFinal(
      outputPath,
      Math.ceil(realSizeBytes / (1024 * 1024)),
      estimatedTotalBytes ? Math.ceil(estimatedTotalBytes / (1024 * 1024)) : null
    );
  } finally {
    await safeRm(tempRoot);
  }
}

async function runWizard() {
  // 1) files input

  console.log("   _____            __         __                              ");
  console.log("  |___ / _ __ ___  / _|       / /  ___   ___  _ __   ___ _ __  ");
  console.log("    |_ \\| '_ ` _ \\| |_ _____ / /  / _ \\ / _ \\| '_ \\ / _ \\ '__| ");
  console.log("   ___) | | | | | |  _|_____/ /___ (_) | (_) | |_) |  __/ |    ");
  console.log("  |____/|_| |_| |_|_|       \\____/\\___/ \\___/| .__/ \\___|_|    ");
  console.log("                                             |_|               ");

  console.log(`One liner usage: ${colorVar('3mf-gcode-looper <count|time|grams>')} ${colorVar('[--all-gcodes|--first-gcode]')} ${colorVar('<file1.3mf>')} ${colorVar('[file2.3mf ...]')}`);
  console.log(`Examples: "3mf-gcode-looper 100g file1.3mf" or "3mf-gcode-looper 2h file1.3mf" or "3mf-gcode-looper 5 file1.3mf"`);
  console.log('--all-gcodes flag makes the tool use all GCODEs (sliced plates) inside of the files');
  console.log('Example: "3mf-gcode-looper 100g --all-gcodes file1.3mf file2.3mf"');
  console.log('');
  console.log('Starting wizard...');
  const filesRes = await prompts({
    type: 'text',
    name: 'paths',
    message: 'Paste or drop .3mf files (one per line, or quote paths with spaces):',
    validate: (val) => (String(val).trim().length ? true : 'Please provide at least one file path'),
  });
  if (!filesRes || !filesRes.paths) throw new Error('Cancelled');
  const inputPaths = splitPaths(filesRes.paths);
  if (inputPaths.length === 0) throw new Error('No valid files.');

  // 2) discover candidates and prompt per input
  const gcodeNameCandidatesPerInput = [];
  for (let i = 0; i < inputPaths.length; i += 1) {
    const names = await listTopLevelGcodesInZip(inputPaths[i]);
    if (names.length === 0) throw new Error(`No top-level metadata/*.gcode found in input ${i + 1}.`);
    gcodeNameCandidatesPerInput.push(names);
  }
  const selectedNamesPerInput = [];
  for (let i = 0; i < gcodeNameCandidatesPerInput.length; i += 1) {
    const chosen = await promptSelectGcodesForInput(inputPaths[i], gcodeNameCandidatesPerInput[i]);
    selectedNamesPerInput.push(chosen);
  }

  // 3) extract
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gcode-3mf-looper-'));
  try {
    const extractedDirs = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      const subdir = path.join(tempRoot, `input-${i + 1}`);
      await extractZipToDir(inputPaths[i], subdir);
      extractedDirs.push(subdir);
    }
    const metadataDirs = [];
    for (let i = 0; i < extractedDirs.length; i += 1) {
      const md = await findMetadataDirectory(extractedDirs[i]);
      if (!md) throw new Error(`Could not find a metadata directory in input ${i + 1}.`);
      metadataDirs.push(md);
    }
    const gcodePaths = [];
    const displayNames = [];
    for (let i = 0; i < selectedNamesPerInput.length; i += 1) {
      for (const name of selectedNamesPerInput[i]) {
        gcodePaths.push(path.join(metadataDirs[i], name));
        displayNames.push(name);
      }
    }
    // 4) analyze
    const analyses = [];
    for (let i = 0; i < gcodePaths.length; i += 1) {
      analyses.push(await analyzeGcodeFile(gcodePaths[i]));
    }
    const perLoopMinutes = analyses.reduce((sum, a) => sum + (a.minutes || 0), 0);
    const perLoopGrams = analyses.reduce((sum, a) => sum + (a.grams || 0), 0);

    console.log(`Per loop totals: ${perLoopMinutes} min, ${perLoopGrams.toFixed(2)} g`);

    // 5) choose target and value with preview, allow retry when user says No
    let loopSpec;
    let repetitions;
    let durationLabel;
    let totalGrams;
    while (true) {
      const modeRes = await prompts({
        type: 'select',
        name: 'mode',
        message: 'How would you like to loop? (by repetition number, time, or filament weight)',
        choices: [
          { title: 'Repetition number', value: 'count' },
          { title: 'Time', value: 'time' },
          { title: 'Filament weight', value: 'grams' },
        ],
        hint: 'Use ↑/↓ to choose, Enter/Return to submit',
        initial: 0,
      });
      if (!modeRes || !modeRes.mode) throw new Error('Cancelled');

      if (modeRes.mode === 'count') {
        const val = await prompts({ type: 'number', name: 'n', message: 'How many loops?', validate: (v) => (v >= 1 ? true : 'Enter a positive integer') });
        if (!val || !Number.isInteger(val.n) || val.n < 1) throw new Error('Cancelled');
        loopSpec = { type: 'count', value: val.n };
      } else if (modeRes.mode === 'time') {
        const t = await prompts({ type: 'text', name: 'txt', message: 'Maximum time (e.g., 120m, 2h, 1d) — generates as many loops as fit.', validate: (v) => (parseLoopSpecifier(v).type === 'time' ? true : 'Use m/h/d units, e.g., 2h') });
        if (!t || !t.txt) throw new Error('Cancelled');
        loopSpec = parseLoopSpecifier(t.txt);
      } else {
        const g = await prompts({ type: 'text', name: 'txt', message: 'Maximum filament (e.g., 100g or 2.5kg) — generates as many loops as fit.', validate: (v) => (parseLoopSpecifier(v).type === 'grams' ? true : 'Use g or kg units, e.g., 100g or 2.5kg') });
        if (!g || !g.txt) throw new Error('Cancelled');
        loopSpec = parseLoopSpecifier(g.txt);
      }

      if (loopSpec.type === 'count') repetitions = loopSpec.value;
      else if (loopSpec.type === 'time') repetitions = Math.floor(loopSpec.minutes / (perLoopMinutes || 1));
      else if (loopSpec.type === 'grams') repetitions = Math.floor(loopSpec.grams / (perLoopGrams || 1));
      if (!Number.isInteger(repetitions) || repetitions < 1) {
        const warn = await prompts({ type: 'confirm', name: 'ok', message: 'Target yields 0 loops. Try again?', initial: true });
        if (!warn || !warn.ok) throw new Error('Cancelled');
        continue;
      }

      const totalMinutes = perLoopMinutes * repetitions;
      totalGrams = Math.ceil(perLoopGrams * repetitions);
      durationLabel = formatDuration(totalMinutes);

      // Estimate final size for preview
      let previewSizeMb = null;
      try {
        const firstZipSize = (await fsp.stat(inputPaths[0])).size;
        const sizeMapsPreview = [];
        for (let i = 0; i < inputPaths.length; i += 1) {
          sizeMapsPreview.push(await getTopLevelGcodeSizes(inputPaths[i]));
        }
        const estBytes = estimateFinalSize(firstZipSize, sizeMapsPreview, selectedNamesPerInput, repetitions);
        if (estBytes) previewSizeMb = Math.ceil(estBytes / (1024 * 1024));
      } catch {}

      const review = await prompts({
        type: 'confirm',
        name: 'ok',
        message: `Preview: ${colorVar(`${repetitions}x`)} Loops | ${colorVar(`${durationLabel}`)} | ${colorVar(`${formatMass(totalGrams)}`)}${previewSizeMb != null ? ` | ${colorVar(`~${previewSizeMb}mb`)}` : ''}. Generate?`,
        initial: true,
      });
      if (review && review.ok) break;
      // else retry the selection/value flow
    }

    // 6) write & zip
    const firstInputPath = inputPaths[0];
    const { dir: inputDir } = path.parse(firstInputPath);
    const workingDir = extractedDirs[0];
    const firstGcodePath = gcodePaths[0];
    const tmpGcodePath = firstGcodePath + '.tmp';
    await streamRepeatFiles(gcodePaths, tmpGcodePath, repetitions, displayNames);
    await fsp.rename(tmpGcodePath, firstGcodePath);
    const coreName = path.parse(firstInputPath).name.replace(/\.gcode$/i, '');
    const outputName = `Loop X ${repetitions} - ${durationLabel} - ${totalGrams}g - ${coreName}.gcode.3mf`;
    const outputPath = path.join(inputDir, outputName);
    // Estimate in wizard too
    const firstZipSize = (await fsp.stat(firstInputPath)).size;
    const sizeMaps = [];
    for (let i = 0; i < inputPaths.length; i += 1) {
      sizeMaps.push(await getTopLevelGcodeSizes(inputPaths[i]));
    }
    const estimatedTotalBytes = estimateFinalSize(firstZipSize, sizeMaps, selectedNamesPerInput, repetitions);
    const ONE_GB = 1024 * 1024 * 1024;
    if (estimatedTotalBytes && estimatedTotalBytes > ONE_GB) {
      const cont = await prompts({ type: 'confirm', name: 'ok', message: `Estimated size ~ ${Math.ceil(estimatedTotalBytes / (1024*1024))} MB exceeds 1 GB. Continue?`, initial: false });
      if (!cont || !cont.ok) throw new Error('Cancelled');
    }
    await zipDirectoryContents(workingDir, outputPath);
    const realSizeBytes = (await fsp.stat(outputPath)).size;
    printFinal(
      outputPath,
      Math.ceil(realSizeBytes / (1024 * 1024)),
      estimatedTotalBytes ? Math.ceil(estimatedTotalBytes / (1024 * 1024)) : null
    );

    // Tip: show equivalent non-interactive command
    const anyMulti = selectedNamesPerInput.some((cands, idx) => cands.length > 1);
    const allAll = selectedNamesPerInput.every((sel, idx) => sel.length === gcodeNameCandidatesPerInput[idx].length);
    const allFirst = selectedNamesPerInput.every((sel, idx) => {
      const cands = gcodeNameCandidatesPerInput[idx];
      return cands.length <= 1 || (sel.length === 1 && sel[0] === cands[0]);
    });
    let flagHint = '';
    if (anyMulti) {
      if (allAll) flagHint = ' --all-gcodes';
      else if (allFirst) flagHint = ' --first-gcode';
    }
    const countArg = `${repetitions}`; // use count for shortest form
    const filesPart = inputPaths.map((p) => `"${p}"`).join(' ');
    console.log('');
    console.log(`Hint: If you need to generate this file again, use this command:`);
    console.log(`${colorVar(`3mf-gcode-looper ${countArg}${flagHint} ${filesPart}`)}`);
  } finally {
    await safeRm(tempRoot);
  }
}

function splitPaths(input) {
  // Extract tokens as: double-quoted, single-quoted, or non-whitespace sequences
  const tokens = [];
  const re = /"([^"]+)"|'([^']+)'|([^\s]+)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    const token = m[1] || m[2] || m[3];
    if (token) tokens.push(token);
  }
  return tokens.map((p) => path.resolve(process.cwd(), p));
}

module.exports = { run };

async function fileSize(p) {
  const st = await fsp.stat(p);
  return st.size;
}

function estimateFinalSize(firstZipSize, sizeMaps, selectedNamesPerInput, repetitions) {
  try {
    // Original compressed size of selected gcode inside first zip
    const firstMap = sizeMaps[0];
    let origCompressed = 0;
    for (const name of selectedNamesPerInput[0]) {
      const meta = firstMap[name];
      if (meta && typeof meta.compressedSize === 'number') origCompressed += meta.compressedSize;
    }
    // Uncompressed bytes per loop and derive compression ratio from inputs
    let perLoopUncompressed = 0;
    let totalOrigUncompressed = 0;
    let totalOrigCompressed = 0;
    for (let i = 0; i < selectedNamesPerInput.length; i += 1) {
      const map = sizeMaps[i];
      for (const name of selectedNamesPerInput[i]) {
        const meta = map[name];
        if (meta && typeof meta.uncompressedSize === 'number') perLoopUncompressed += meta.uncompressedSize;
        if (meta && typeof meta.uncompressedSize === 'number' && typeof meta.compressedSize === 'number') {
          totalOrigUncompressed += meta.uncompressedSize;
          totalOrigCompressed += meta.compressedSize;
        }
      }
    }
    const ratio = totalOrigUncompressed > 0 ? (totalOrigCompressed / totalOrigUncompressed) : 0.5;
    const newCompressedGcode = Math.ceil(perLoopUncompressed * repetitions * ratio);
    const estimatedTotal = Math.max(0, firstZipSize - origCompressed + newCompressedGcode);
    return estimatedTotal;
  } catch (e) {
    return null;
  }
}


