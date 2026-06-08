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

const patch = {};
for (const ex of nasmExercises) {
  const key = normalize(ex.title);
  if (!key) continue;
  patch[key] = {
    videoUrl:     ex.videoUrl     || null,
    thumbnailUrl: ex.thumbnailUrl || null,
    steps:        Array.isArray(ex.steps) ? ex.steps : [],
  };
}
console.log(`Built NASM patch with ${Object.keys(patch).length} entries`);

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

const patchCode = 'const NASM_PATCH = ' + JSON.stringify(patch, null, 2) + ';';
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
  const nameRx = /\{id:\d+,name:"([^"]+)"/g;
  let m;
  let total = 0, matchedNames = [];
  while ((m = nameRx.exec(template)) !== null) {
    total++;
    if (patch[normalize(m[1])]) matchedNames.push(m[1]);
  }
  console.log(`\nMatched ${matchedNames.length} / ${total} exercises with NASM video + steps`);
  if (matchedNames.length > 0) {
    console.log('Matched exercises:');
    matchedNames.forEach(n => console.log('  ✓', n));
  }

  const unmatched = Object.keys(patch).filter(k => !matchedNames.some(n => normalize(n) === k));
  if (unmatched.length > 0) {
    console.log(`\nNASM exercises with no Cowork match (${unmatched.length}):`);
    unmatched.forEach(k => console.log('  ✗', k));
  }
}

console.log('\nDone!');
console.log('  • Preview locally:  open nasm-exercises/index.html');
console.log('  • Deploy to notsexyfitness: push nasm-exercises/index.html to that repo');
console.log('  • Deploy to playwright-mcp Pages: commit + push docs/index.html');
