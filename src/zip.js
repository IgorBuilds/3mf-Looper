const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const unzipper = require('unzipper');
const archiver = require('archiver');

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
    archive.directory(sourceDir + '/', false);
    archive.finalize();
  });
}

async function listTopLevelGcodesInZip(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const names = [];
  for (const entry of directory.files) {
    if (entry.type !== 'File' || !entry.path) continue;
    let p = entry.path.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('/')) p = p.slice(1);
    const segments = p.split('/');
    if (segments.length !== 2) continue;
    const [first, second] = segments;
    if (first.toLowerCase() !== 'metadata') continue;
    if (!second.toLowerCase().endsWith('.gcode')) continue;
    names.push(second);
  }
  return names;
}

// Return a map of top-level metadata GCODE names to { compressedSize, uncompressedSize }
async function getTopLevelGcodeSizes(zipPath) {
  const directory = await unzipper.Open.file(zipPath);
  const result = {};
  for (const entry of directory.files) {
    if (entry.type !== 'File' || !entry.path) continue;
    let p = entry.path.replace(/\\/g, '/');
    if (p.startsWith('./')) p = p.slice(2);
    if (p.startsWith('/')) p = p.slice(1);
    const segments = p.split('/');
    if (segments.length !== 2) continue;
    const [first, second] = segments;
    if (first.toLowerCase() !== 'metadata') continue;
    if (!second.toLowerCase().endsWith('.gcode')) continue;
    // Some unzipper versions expose compressedSize; fallback to null if not present
    const compressedSize = typeof entry.compressedSize === 'number' ? entry.compressedSize : null;
    const uncompressedSize = typeof entry.uncompressedSize === 'number' ? entry.uncompressedSize : null;
    result[second] = { compressedSize, uncompressedSize };
  }
  return result;
}

async function findMetadataDirectory(rootDir) {
  const candidate = path.join(rootDir, 'metadata');
  const st = await safeStat(candidate);
  if (st && st.isDirectory()) return candidate;
  // try case-insensitive variants
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.toLowerCase() === 'metadata') {
      return path.join(rootDir, entry.name);
    }
  }
  return null;
}

module.exports = {
  safeStat,
  safeRm,
  extractZipToDir,
  zipDirectoryContents,
  listTopLevelGcodesInZip,
  findMetadataDirectory,
  getTopLevelGcodeSizes,
};


