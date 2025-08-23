const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const prompts = require('prompts');
const { spawn } = require('child_process');

const { safeStat, safeRm, extractZipToDir, zipDirectoryContents, listTopLevelGcodesInZip, findMetadataDirectory, getTopLevelGcodeSizes } = require('./zip');
const { analyzeGcodeFile, streamRepeatFiles } = require('./gcode');
const { formatDuration, formatMass, parseLoopSpecifier } = require('./compute');
const { printFinal } = require('./log');

const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DARK_GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function cyanColor(text) {
  return `${BOLD}${CYAN}${text}${RESET}`;
}

function magentaColor(text) {
  return `${BOLD}${MAGENTA}${text}${RESET}`;
}

function darkGreenColor(text) {
  return `${BOLD}${DARK_GREEN}${text}${RESET}`;
}

function bold(text) {
  return `${BOLD}${text}${RESET}`;
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

  const fileArgs = rawArgs;
  if (fileArgs.length === 0) {
    throw new Error('Missing .3mf files.');
  }
  // Flags removed: a 3MF is expected to contain exactly one top-level metadata/*.gcode

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

    // 2) Enforce exactly one GCODE per input
    const selectedNamesPerInput = [];
    for (let i = 0; i < gcodeNameCandidatesPerInput.length; i += 1) {
      const candidates = gcodeNameCandidatesPerInput[i];
      if (candidates.length !== 1) {
        throw new Error(`Expected exactly one top-level metadata/*.gcode in input ${i + 1}, found ${candidates.length}.`);
      }
      selectedNamesPerInput.push([candidates[0]]);
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

    // Offer to open containing folder in Finder (macOS)
    try {
      const res = await prompts({ type: 'confirm', name: 'ok', message: 'Open containing folder in Finder?', initial: false });
      if (res && res.ok && process.platform === 'darwin') {
        spawn('open', ['-R', outputPath], { stdio: 'ignore', detached: true }).unref();
      }
    } catch {}
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
  console.log('           Loop prints to the infinite and beyond! 🚀');
  console.log('');
  console.log('');
  console.log(`                               Loop parameter            Files`);
  console.log(`One liner usage: ${cyanColor('3mf-looper <count|time|weight>')} ${cyanColor('<file1.3mf>')} ${cyanColor('[file2.3mf file3.3mf...]')}`);
  console.log('')
  console.log(`Loop value:  4(count),  4d | 2h | 120m(time),  100g | 2.5kg(weight)`);
  console.log(`Examples:  ${cyanColor('3mf-looper 33 file1.3mf')} or ${darkGreenColor('3mf-looper 500g file1.3mf file2.3mf')} or ${magentaColor('3mf-looper 2h file1.3mf file2.3mf')}`);

  console.log('');
  // A 3MF is expected to contain exactly one top-level metadata/*.gcode
  console.log(cyanColor('Starting wizard...'));
  console.log('');
  const filesRes = await prompts({
    type: 'text',
    name: 'paths',
    message: 'Paste or drop .3mf files (one per line, or quote paths with spaces):',
    validate: (val) => (String(val).trim().length ? true : 'Please provide at least one file path'),
  });
  if (!filesRes || !filesRes.paths) throw new Error('Cancelled');
  const inputPaths = splitPaths(filesRes.paths);
  if (inputPaths.length === 0) throw new Error('No valid files.');

  // 2) discover candidates and enforce single GCODE per input
  const gcodeNameCandidatesPerInput = [];
  for (let i = 0; i < inputPaths.length; i += 1) {
    const names = await listTopLevelGcodesInZip(inputPaths[i]);
    if (names.length === 0) throw new Error(`No top-level metadata/*.gcode found in input ${i + 1}.`);
    if (names.length !== 1) throw new Error(`Expected exactly one top-level metadata/*.gcode in input ${i + 1}, found ${names.length}.`);
    gcodeNameCandidatesPerInput.push(names);
  }
  const selectedNamesPerInput = gcodeNameCandidatesPerInput.map((arr) => [arr[0]]);

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

    // 5) single-field target with preview, allow retry when user says No
    let loopSpec;
    let repetitions;
    let durationLabel;
    let totalGrams;
    while (true) {
      const t = await prompts({
        type: 'text',
        name: 'txt',
        message: 'How would you like to loop?\n- Count: enter an integer (e.g., 4)\n- Time: enter the total time to be used (120m, 2h, or 1d)\n- Filament: enter the total amount of filament to be used (100g or 2.5kg)\n',
        validate: (v) => (parseLoopSpecifier(v).type !== 'invalid' ? true : 'Enter: integer count (e.g., 5), time (120m/2h/1d), or weight (100g/2.5kg)')
      });
      if (!t || !t.txt) throw new Error('Cancelled');
      loopSpec = parseLoopSpecifier(t.txt);

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
        message: `Preview: ${cyanColor(`${repetitions}x`)} Loops | ${cyanColor(`${durationLabel}`)} | ${cyanColor(`${formatMass(totalGrams)}`)}${previewSizeMb != null ? ` | ${cyanColor(`~${previewSizeMb}mb`)}` : ''}. Generate?`,
        initial: true,
      });
      if (review && review.ok) break;
      // else retry the entry
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
    const countArg = `${repetitions}`; // use count for shortest form
    const filesPart = inputPaths.map((p) => `"${p}"`).join(' ');
    console.log('');
    console.log(`Hint: If you need to generate this file again, use this command:`);
    console.log(`${cyanColor(`3mf-looper ${countArg} ${filesPart}`)}`);

    // Offer to open containing folder in Finder (macOS)
    try {
      const res2 = await prompts({ type: 'confirm', name: 'ok', message: 'Open containing folder in Finder?', initial: false });
      if (res2 && res2.ok && process.platform === 'darwin') {
        spawn('open', ['-R', outputPath], { stdio: 'ignore', detached: true }).unref();
      }
    } catch {}

  } finally {
    await safeRm(tempRoot);
  }
}

function splitPaths(input) {
  // Robust tokenizer supporting quotes and backslash-escaped characters (e.g., spaces)
  const tokens = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') { // escape next char (handles \ and \space)
      escaped = true;
      continue;
    }
    if (!inSingle && ch === '"') { inDouble = !inDouble; continue; }
    if (!inDouble && ch === '\'') { inSingle = !inSingle; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
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


