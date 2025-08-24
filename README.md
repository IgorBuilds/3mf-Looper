# 3mf-looper

Open source CLI to loop the `.gcode` content inside a `.3mf` archive N times, useful for running the same print multiple times on a print farm.

## Wizard
https://github.com/user-attachments/assets/5404b07e-ee54-4496-8782-0f354ac51792

## One line command
![One Line Example](https://raw.githubusercontent.com/IgorBuilds/3mf-Looper/refs/heads/main/images/OneLineExample.gif)


## Install

If you already have Node.js and npm installed, install the tool globally:

```bash
npm install -g @igorbuilds/3mf-looper
```

If you don’t have Node yet:
- Go to [nodejs.org/en/download](https://nodejs.org/en/download) and install the LTS version
- Then run the install command above

## Usage

```bash
3mf-looper <count|time|grams> <file1.3mf> [file2.3mf file3.3mf ...]
```

- count: positive integer (e.g., `5`)
- time: number with unit `m`, `h`, or `d` (e.g., `120m`, `2h`, `1d`)
- weight: number with unit `g` or `kg` (e.g., `100g`, `2.5kg`)
- One or more `.3mf` files
  

## Examples

```bash
# Count-based
3mf-looper 5 /path/to/file1.3mf
# Simplest way 

# Time-based (3 hours total)
3mf-looper 3h /path/to/file1.3mf /path/to/file2.3mf
# Get GCODE(s) print time and fits as many possible loops in the given time

# Filament-based (100 grams total)
3mf-looper 100g /path/to/file1.3mf
# Get GCODE(s) filament usage and fit as many possible loops in the given weight
```

#### The process:
- Unzips the `.3mf` to a temporary directory
- Search for the `.gcode` file
- Stream-concatenates the `.gcode` file `loopCount` times (memory-efficient)
- Analyzes each input’s G-code to compute per-loop total time and filament usage
- Re-zips to `Loop X {repetitionCount} - {H}h{M}m - {grams}g - {originalFileNameWithoutTrailing.gcode}.gcode.3mf`
- Cleans up temp files
- Ask to open file's folder

If the `.3mf` lacks a root `metadata/` folder or no top-level `.gcode` is found there, it fails with an error.

Additionally, the tool injects comments:
- Header and footer (same text) at the very start and end:
  `; File modificated at {YYYY-MM-DD HH:MM:SS} for {repetitions} loops for files: {file1, file2, ...}`
- Between each repetition (before loops 2..N):
  `; Starting loop {number}`
 - Before each file’s content within a loop:
  `; Starting loop {number} for "{fileName}"`

### Multiple input files

- When multiple files are provided, their `.gcode` contents are appended in order per loop, and the combined result replaces the first input’s `.gcode` before re-zipping.
  Example for two files (A then B):
  ```
  ; File modificated at ...
  {File A}
  {File B}
  ; Starting loop 2
  {File A}
  {File B}
  ; Starting loop 3
  ...
  ; File modificated at ...
  ```

## Notes
- Uses streaming to handle large `.gcode` files
- Original file is untouched


## Development

If you want to run the latest version from this repository:

1) Clone this repository
2) Install dependencies:

```bash
npm install
```

3) Install the CLI globally from the local folder (so the `3mf-looper` command points here):

```bash
npm install --global .
```

4) After making changes, reinstall to update your global command:

```bash
npm install --global .
```

Tip: advanced users can use `npm link` for a live symlinked global command during development.
