const path = require('path');
const prompts = require('prompts');

async function promptSelectGcodesForInput(inputPath, candidates) {
  if (candidates.length <= 1) return candidates;
  const res = await prompts({
    type: 'multiselect',
    name: 'files',
    message: `Select GCODE(s) for ${path.basename(inputPath)} (Space to toggle, Enter to confirm)`,
    choices: [
      { title: 'All (every .gcode)', value: '*ALL*' },
      ...candidates.map((n) => ({ title: n, value: n })),
    ],
    hint: 'Use arrows/space to select; order will match zip order',
    min: 1,
  });
  if (!res || !res.files) throw new Error('Selection cancelled.');
  const values = Array.isArray(res.files) ? res.files : [res.files];
  return values.includes('*ALL*') ? candidates : candidates.filter((n) => values.includes(n));
}

module.exports = {
  promptSelectGcodesForInput,
};


