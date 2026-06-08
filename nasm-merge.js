#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const TEMPLATE   = path.join(__dirname, 'exercise-library-template.html');
const DATA_FILE  = path.join(__dirname, 'nasm-exercises', 'data', 'exercises.json');
const OUT_LOCAL  = path.join(__dirname, 'nasm-exercises', 'index.html');
const OUT_DEPLOY = path.join(__dirname, 'docs', 'index.html');

// ─── Load NASM scraped data ────────────────────────────────────────────────────
let nasmExercises = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    nasmExercises = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`Loaded ${nasmExercises.length} NASM exercises`);
  } catch (e) {
    console.error('Failed to parse exercises.json:', e.message);
    process.exit(1);
  }
} else {
  console.warn(`⚠ NASM data not found at: ${DATA_FILE}`);
  console.warn('  Run the NASM scraper first (node nasm-rebuild.js) to generate it.');
  console.warn('  Continuing — output will have no enriched video/steps data.\n');
}

// ─── Build normalized lookup ───────────────────────────────────────────────────
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

// Strip trailing 's' for plural-agnostic matching
function singular(str) {
  return str.endsWith('s') ? str.slice(0, -1) : str;
}

// Sort words alphabetically to match regardless of word order
function wordSort(str) {
  return str.split(' ').sort().join(' ');
}

const patch = {};
for (const ex of nasmExercises) {
  const key = normalize(ex.title);
  if (!key) continue;
  const data = {
    videoUrl:     ex.videoUrl     || null,
    thumbnailUrl: ex.thumbnailUrl || null,
    steps:        Array.isArray(ex.steps) ? ex.steps : [],
  };
  patch[key] = data;
}
console.log(`Built NASM patch with ${Object.keys(patch).length} entries`);

// Build secondary lookups for fuzzy matching
const patchSingular  = {};  // singular form → data
const patchWordSort  = {};  // word-sorted form → data
for (const [key, data] of Object.entries(patch)) {
  const s = singular(key);
  if (s !== key) patchSingular[s] = patchSingular[s] || data;
  const ws = wordSort(key);
  if (ws !== key) patchWordSort[ws] = patchWordSort[ws] || data;
}

// Lookup NASM data for a Cowork exercise name using cascaded fuzzy matching
function lookupPatch(name) {
  const key = normalize(name);
  if (patch[key])                        return { data: patch[key], how: 'exact' };
  const s = singular(key);
  if (patch[s])                          return { data: patch[s],   how: 'singular' };
  if (patchSingular[s])                  return { data: patchSingular[s], how: 'singular' };
  const ws = wordSort(key);
  if (patchWordSort[ws])                 return { data: patchWordSort[ws], how: 'word-sort' };
  const wss = wordSort(s);
  if (patchWordSort[wss])                return { data: patchWordSort[wss], how: 'word-sort+singular' };
  return null;
}

// ─── Read template ─────────────────────────────────────────────────────────────
if (!fs.existsSync(TEMPLATE)) {
  console.error(`Template not found: ${TEMPLATE}`);
  process.exit(1);
}
const template = fs.readFileSync(TEMPLATE, 'utf8');

// ─── Inject patch data ─────────────────────────────────────────────────────────
const PATCH_MARKER = 'const NASM_PATCH = {};';
if (!template.includes(PATCH_MARKER)) {
  console.error('Marker "const NASM_PATCH = {};" not found in template.');
  console.error('The template may have been modified. Check exercise-library-template.html.');
  process.exit(1);
}

// Build the effective patch keyed by normalized Cowork exercise names (what the browser uses)
const nameRx = /\{id:\d+,name:"([^"]+)"/g;
let m;
const effectivePatch = {};
const matchedNames = [];
const unmatchedNasm = new Set(Object.keys(patch));

while ((m = nameRx.exec(template)) !== null) {
  const coworkName = m[1];
  const result = lookupPatch(coworkName);
  if (result) {
    const coworkKey = normalize(coworkName);
    effectivePatch[coworkKey] = result.data;
    matchedNames.push({ name: coworkName, how: result.how });
    // Mark the NASM source as used
    for (const [k, v] of Object.entries(patch)) {
      if (v === result.data) { unmatchedNasm.delete(k); break; }
    }
  }
}

const patchCode = 'const NASM_PATCH = ' + JSON.stringify(effectivePatch, null, 2) + ';';
const merged = template.replace(PATCH_MARKER, patchCode);

// ─── Write outputs ─────────────────────────────────────────────────────────────
function writeOut(outPath, content) {
  const dir = path.dirname(outPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outPath, content, 'utf8');
  console.log(`  Written ${Math.round(content.length / 1024)} KB → ${path.relative(__dirname, outPath)}`);
}

console.log('\nWriting output files:');
writeOut(OUT_LOCAL,  merged);
writeOut(OUT_DEPLOY, merged);

// ─── Report match stats ────────────────────────────────────────────────────────
if (nasmExercises.length > 0) {
  console.log(`\nMatched ${matchedNames.length} / ${Object.keys(patch).length} NASM exercises into Cowork library`);
  if (matchedNames.length > 0) {
    console.log('Matched exercises:');
    matchedNames.forEach(({ name, how }) => {
      const tag = how !== 'exact' ? ` (${how})` : '';
      console.log(`  ✓ ${name}${tag}`);
    });
  }

  if (unmatchedNasm.size > 0) {
    console.log(`\nNASM exercises with no Cowork match (${unmatchedNasm.size}):`);
    [...unmatchedNasm].forEach(k => console.log('  ✗', k));
  }
}

console.log('\nDone!');
console.log('  • Preview locally:  open nasm-exercises/index.html');
console.log('  • Deploy to notsexyfitness: push nasm-exercises/index.html to that repo');
console.log('  • Deploy to playwright-mcp Pages: commit + push docs/index.html');
