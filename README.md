# 3mf-gcode-looper

CLI to duplicate the `.gcode` inside a `.3mf` archive N times, useful for running the same print multiple times on a print farm.

## Install

```bash
npm install --global .
```

## Usage

```bash
3mf-gcode-looper <count|time|grams> [--all-gcodes|--first-gcode] <file1.3mf> [file2.3mf ...]
```

- count: positive integer (e.g., `5`)
- time: number with unit `m`, `h`, or `d` (e.g., `120m`, `2h`, `1d`)
- grams: number with unit `g` or `kg` (e.g., `100g`, `2.5kg`)
- One or more `.3mf` files
- Flags:
  - `--all-gcodes`: include all top-level `metadata/*.gcode` from each input
  - `--first-gcode`: include only the first top-level `.gcode` from each input

The tool:
- Unzips the `.3mf` to a temporary directory
- For each input: finds the first `.gcode` in the top-level of `metadata/`
- Stream-concatenates the `.gcode` file `repetitionCount` times (memory-efficient)
- Analyzes each input’s G-code to compute per-loop total time and filament usage
- Re-zips to `Loop X {repetitionCount} - {H}h{M}m - {grams}g - {originalFileNameWithoutTrailing.gcode}.gcode.3mf`
- Cleans up temp files

If the `.3mf` lacks a root `metadata/` folder or no top-level `.gcode` is found there, it fails with an error.

Additionally, the tool injects comments:
- Header and footer (same text) at the very start and end:
  `; File modificated at {YYYY-MM-DD HH:MM:SS} for {repetitions} loops for files: {file1, file2, ...}`
- Between each repetition (before loops 2..N):
  `; Starting loop {number}`
 - Before each file’s content within a loop:
  `; Starting loop {number} for "{fileName}"`

### Multiple inputs

- When multiple files are provided, their `.gcode` contents are appended in order per loop, and the combined result replaces the first input’s `.gcode` before re-zipping.
- If an input contains multiple top-level `metadata/*.gcode` files:
  - In interactive terminals, a multi-select prompt lets you choose which to include (or select “All”). Ordering follows the original ZIP order.
  - In non-interactive mode, you must pass `--all-gcodes` or `--first-gcode`. Otherwise the program errors out without writing output.
  Example for two files (A then B):
  ```
  ; File modificated at ...
  {A}
  {B}
  ; Starting loop 2
  {A}
  {B}
  ; Starting loop 3
  ...
  ; File modificated at ...
  ```

## Notes
- Uses streaming to handle large `.gcode` files (50MB+)
- Output preserves directory structure; file order inside zip may differ from the original
- Original file is untouched
- If input `.3mf` > 100 MB, a colored WARNING is printed but the process continues

## Example

```bash
# Count-based
3mf-gcode-looper 5 /path/to/model.3mf
# => /path/to/Loop X 5 - 2h33m - 13g - model.gcode.3mf

# Time-based (2 hours total)
3mf-gcode-looper 2h /path/to/model.3mf
# loops = floor(120 / perLoopMinutes)

# Filament-based (100 grams total)
3mf-gcode-looper 100g /path/to/model.3mf
# loops = floor(100 / perLoopGrams)
```
