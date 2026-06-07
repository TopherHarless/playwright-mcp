/**
 * NASM Exercise Library Scraper
 * Run this on your LOCAL machine (not a cloud server) since nasm.org blocks datacenter IPs.
 *
 * Setup:
 *   npm install playwright
 *   npx playwright install chromium
 *   node nasm-scraper.js
 *
 * Output:
 *   nasm-exercises/data/exercises.json   — all exercise metadata
 *   nasm-exercises/images/               — downloaded thumbnails/images
 *   nasm-exercises/index.html            — local filter/search viewer (open in browser)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ─── config ────────────────────────────────────────────────────────────────
const BASE    = 'https://www.nasm.org/resource-center/exercise-library';
const OUT_DIR = path.join(__dirname, 'nasm-exercises');
const DATA_DIR = path.join(OUT_DIR, 'data');
const IMG_DIR  = path.join(OUT_DIR, 'images');

// Known exercise slugs harvested from Google's index.
// The scraper will also discover more by crawling the listing page.
const SEED_SLUGS = [
  'barbell-bench-press',
  'barbell-bench-press-with-bands',
  'barbell-bench-press-with-chains',
  'barbell-bicep-curl',
  'barbell-deadlift',
  'bench-dips',
  'box-jumps',
  'bulgarian-split-squat',
  'cable-crossover',
  'chest-press-machine',
  'close-grip-bench-press',
  'dead-bug',
  'dumbbell-romanian-deadlift',
  'face-pull',
  'foam-roll-adductors',
  'foam-roll-calves',
  'foam-roll-latissimus-dorsi',
  'good-mornings',
  'incline-barbell-bench-press',
  'incline-push-up',
  'inverted-push-up',
  'iron-cross',
  'jumping-jacks',
  'kettlebell-deadlift',
  'leg-press',
  'leg-press-calf-raise',
  'lunge-jump',
  'lying-leg-curl',
  'lying-leg-curl-two-leg-concentric-single-leg-eccentric',
  'modified-push-up',
  'plank',
  'plank-walkup',
  'pull-up',
  'push-up',
  'romanian-deadlift-barbell',
  'seated-leg-curl',
  'side-plank',
  'single-arm-dumbbell-chest-press',
  'single-arm-incline-dumbbell-chest-press',
  'single-leg-press',
  'single-leg-seated-leg-curl',
  'single-leg-squat',
  'single-leg-squat-to-row',
  'squat-jump',
  'straight-arm-plank',
  'two-arm-incline-dumbbell-chest-press',
];

// ─── helpers ────────────────────────────────────────────────────────────────
for (const d of [OUT_DIR, DATA_DIR, IMG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeName(s) {
  return (s || '').replace(/[^a-z0-9_\-]/gi, '_').replace(/_+/g, '_').slice(0, 100);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve(dest);
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    const req   = proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExerciseScraper/1.0)' },
    }, res => {
      if ([301, 302, 303].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('error', e => { file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest); reject(e); });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── scrape a single exercise detail page ───────────────────────────────────
async function scrapeExercise(page, url) {
  const result = {
    url,
    name: '',
    description: '',
    instructions: [],
    primaryMuscles: [],
    secondaryMuscles: [],
    equipment: [],
    category: '',
    imageUrl: null,
    videoUrl: null,
    relatedUrls: [],
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);

    // scroll to trigger lazy images
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await sleep(500);

    result.name = await page.evaluate(() => {
      return (document.querySelector('h1')?.innerText || document.title || '').trim();
    });

    // description / overview
    result.description = await page.evaluate(() => {
      const candidates = [
        '[class*="overview"] p',
        '[class*="description"] p',
        '[class*="intro"] p',
        'article > p',
        '.field--name-body p',
        'main p',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        const t = el?.innerText?.trim();
        if (t && t.length > 40) return t;
      }
      // fallback: grab all p text until we get something substantial
      for (const p of document.querySelectorAll('p')) {
        const t = p.innerText?.trim();
        if (t && t.length > 60) return t;
      }
      return '';
    });

    // step-by-step instructions
    result.instructions = await page.evaluate(() => {
      const steps = [];
      // ordered lists are the most common pattern
      for (const li of document.querySelectorAll('ol li')) {
        const t = li.innerText?.trim();
        if (t && t.length > 10) steps.push(t);
      }
      if (steps.length) return steps;
      // fallback: numbered sections
      for (const el of document.querySelectorAll('[class*="step"], [class*="instruction"]')) {
        const t = el.innerText?.trim();
        if (t && t.length > 10) steps.push(t);
      }
      return steps;
    });

    // muscles & equipment — extracted from structured metadata sections
    const structured = await page.evaluate(() => {
      const data = { primary: [], secondary: [], equipment: [], category: '' };
      // NASM pages often have labeled sections like "Primary Muscles: ..."
      const fullText = document.body.innerText;

      const extract = (label) => {
        const re = new RegExp(`${label}[:\\s]+([^\\n]+)`, 'i');
        const m = fullText.match(re);
        return m ? m[1].split(/[,;]/).map(s => s.trim()).filter(Boolean) : [];
      };

      data.primary   = extract('Primary Muscles?');
      data.secondary = extract('Secondary Muscles?');
      data.equipment = extract('Equipment');
      const catM = fullText.match(/Category[:\s]+([^\n]+)/i);
      data.category  = catM ? catM[1].trim() : '';

      // also try structured data / JSON-LD
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const json = JSON.parse(s.textContent);
          if (json['@type'] === 'HowTo' || json['@type'] === 'ExercisePlan') {
            if (json.name) data.name = json.name;
          }
        } catch (_) {}
      }

      // look for tag/chip elements
      document.querySelectorAll('[class*="tag"], [class*="chip"], [class*="badge"], [class*="label"]').forEach(el => {
        const t = el.innerText?.trim();
        if (t && t.length < 60 && t.length > 2) data.equipment.push(t);
      });

      return data;
    });

    result.primaryMuscles   = structured.primary;
    result.secondaryMuscles = structured.secondary;
    result.equipment        = [...new Set(structured.equipment)];
    result.category         = structured.category;

    // main image
    result.imageUrl = await page.evaluate(() => {
      const skip = /logo|icon|arrow|blank|header|nav|footer|sprite|pixel|track/i;
      // prefer the largest img in main content
      let best = null, bestArea = 0;
      for (const img of document.querySelectorAll('main img, article img, [class*="content"] img, img')) {
        const src = img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc || '';
        if (!src || !src.startsWith('http') || skip.test(src)) continue;
        const area = (img.naturalWidth || img.width || 0) * (img.naturalHeight || img.height || 0);
        if (area > bestArea) { bestArea = area; best = src; }
      }
      return best;
    });

    // video URL — check <video>, iframes, and JW Player setup scripts
    result.videoUrl = await page.evaluate(() => {
      const vid = document.querySelector('video[src], video source[src]');
      if (vid) return vid.src;
      const iframe = document.querySelector('iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="jwplat"]');
      if (iframe) return iframe.src;
      for (const script of document.querySelectorAll('script:not([src])')) {
        const t = script.textContent;
        const mp4 = t.match(/["'](https?:[^"']+\.mp4[^"']*)/);
        if (mp4) return mp4[1];
        const jw = t.match(/jwplayer[^;]+setup\s*\(\s*\{[^}]*file\s*:\s*["']([^"']+)/);
        if (jw) return jw[1];
      }
      return null;
    });

    // related exercise links for discovery
    result.relatedUrls = await page.evaluate((base) => {
      const links = new Set();
      document.querySelectorAll(`a[href*="/exercise-library/"]`).forEach(a => {
        const href = a.href;
        if (href && !href.endsWith('/exercise-library') && !href.endsWith('/exercise-library/')) {
          links.add(href.split('?')[0].split('#')[0]);
        }
      });
      return [...links];
    }, BASE);

  } catch (e) {
    console.error(`  Error on ${url}: ${e.message}`);
  }

  return result;
}

// ─── discover all exercise URLs from the listing page ───────────────────────
async function discoverAllUrls(page) {
  console.log('Navigating to exercise library listing page...');
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await sleep(2000);

  const found = new Set();

  const harvest = async () => {
    const links = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href;
        if (h && h.includes('/exercise-library/') && !h.endsWith('/exercise-library') && !h.endsWith('/exercise-library/')) {
          urls.push(h.split('?')[0].split('#')[0]);
        }
      });
      return urls;
    });
    links.forEach(u => found.add(u));
  };

  await harvest();
  console.log(`  Found ${found.size} links on first load`);

  // scroll + load more
  let prevSize = 0;
  let unchangedRounds = 0;
  while (unchangedRounds < 4) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(1500);

    // click any "load more" button
    try {
      const btn = page.locator('button:has-text("Load More"), a:has-text("Load More"), button:has-text("Show More"), [class*="load-more"]').first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        await sleep(2000);
      }
    } catch (_) {}

    await harvest();

    if (found.size === prevSize) {
      unchangedRounds++;
    } else {
      unchangedRounds = 0;
      console.log(`  Found ${found.size} links after scroll...`);
    }
    prevSize = found.size;
  }

  // intercept any API pagination — check if there's a JSON data endpoint
  const apiData = await page.evaluate(() => {
    // look for embedded JSON data (common in Drupal/React hydration)
    for (const script of document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__, script[data-drupal-selector]')) {
      try {
        const d = JSON.parse(script.textContent);
        return JSON.stringify(d).substring(0, 3000);
      } catch (_) {}
    }
    return null;
  });
  if (apiData) {
    fs.writeFileSync(path.join(DATA_DIR, 'embedded-data.json'), apiData);
    console.log('  Found embedded JSON data — saved to data/embedded-data.json');
  }

  return [...found];
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  // intercept JSON API responses
  const apiResponses = {};
  context.on('response', async res => {
    const url = res.url();
    const ct  = res.headers()['content-type'] || '';
    if (ct.includes('json') && !url.includes('analytics') && !url.includes('pixel')) {
      try {
        const body = await res.text();
        if (body.startsWith('[') || body.startsWith('{')) {
          apiResponses[url] = body;
          console.log(`  [API] ${url.slice(0, 80)}`);
        }
      } catch (_) {}
    }
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // ── Step 1: discover all URLs ──────────────────────────────────────────
  let allUrls;
  try {
    const discovered = await discoverAllUrls(page);
    const seedUrls   = SEED_SLUGS.map(s => `${BASE}/${s}`);
    allUrls = [...new Set([...seedUrls, ...discovered])];
    console.log(`\nTotal unique exercise URLs: ${allUrls.length}`);
  } catch (e) {
    console.error('Discovery failed, falling back to seed list:', e.message);
    allUrls = SEED_SLUGS.map(s => `${BASE}/${s}`);
  }

  // Save any captured API responses
  if (Object.keys(apiResponses).length) {
    fs.writeFileSync(path.join(DATA_DIR, 'api-captures.json'), JSON.stringify(apiResponses, null, 2));
    console.log(`Saved ${Object.keys(apiResponses).length} API responses`);
  }
  fs.writeFileSync(path.join(DATA_DIR, 'exercise-urls.json'), JSON.stringify(allUrls, null, 2));

  // ── Step 2: scrape each exercise ──────────────────────────────────────
  const exercises   = [];
  const extraUrls   = new Set();

  // load any previous progress
  const progressFile = path.join(DATA_DIR, 'exercises.json');
  const doneUrls = new Set();
  if (fs.existsSync(progressFile)) {
    const prev = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
    prev.forEach(e => { exercises.push(e); doneUrls.add(e.url); });
    console.log(`Resuming — already have ${exercises.length} exercises`);
  }

  let todo = allUrls.filter(u => !doneUrls.has(u));

  for (let i = 0; i < todo.length; i++) {
    const url = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${url.split('/').pop()} ... `);

    const ex = await scrapeExercise(page, url);
    exercises.push(ex);
    console.log(`"${ex.name}" | imgs:${ex.imageUrl ? 1 : 0} vid:${ex.videoUrl ? 1 : 0}`);

    // collect newly discovered URLs
    ex.relatedUrls.forEach(u => {
      if (!doneUrls.has(u) && !allUrls.includes(u)) extraUrls.add(u);
    });

    // download image
    if (ex.imageUrl) {
      const ext  = (ex.imageUrl.split('.').pop().split('?')[0] || 'jpg').slice(0, 5);
      const slug = url.split('/').pop();
      const dest = path.join(IMG_DIR, `${slug}.${ext}`);
      try {
        await downloadFile(ex.imageUrl, dest);
        ex.localImage = `images/${slug}.${ext}`;
      } catch (e) {
        // image download failed — non-fatal
      }
    }

    // save progress every 10 exercises
    if ((i + 1) % 10 === 0) {
      fs.writeFileSync(progressFile, JSON.stringify(exercises, null, 2));
    }

    await sleep(600 + Math.random() * 400); // polite delay
  }

  // scrape any newly discovered URLs
  if (extraUrls.size) {
    console.log(`\nScraping ${extraUrls.size} newly discovered exercises...`);
    for (const url of extraUrls) {
      if (doneUrls.has(url) || exercises.find(e => e.url === url)) continue;
      process.stdout.write(`  ${url.split('/').pop()} ... `);
      const ex = await scrapeExercise(page, url);
      exercises.push(ex);
      console.log(`"${ex.name}"`);
      if (ex.imageUrl) {
        const ext  = (ex.imageUrl.split('.').pop().split('?')[0] || 'jpg').slice(0, 5);
        const slug = url.split('/').pop();
        const dest = path.join(IMG_DIR, `${slug}.${ext}`);
        try { await downloadFile(ex.imageUrl, dest); ex.localImage = `images/${slug}.${ext}`; } catch (_) {}
      }
      await sleep(600);
    }
  }

  // ── Step 3: save final data ────────────────────────────────────────────
  fs.writeFileSync(progressFile, JSON.stringify(exercises, null, 2));
  console.log(`\nSaved ${exercises.length} exercises to data/exercises.json`);

  // build summary
  const muscles   = {};
  const equipment = {};
  const categories = {};
  exercises.forEach(e => {
    [...e.primaryMuscles, ...e.secondaryMuscles].forEach(m => { muscles[m] = (muscles[m] || 0) + 1; });
    e.equipment.forEach(eq => { equipment[eq] = (equipment[eq] || 0) + 1; });
    if (e.category) categories[e.category] = (categories[e.category] || 0) + 1;
  });

  const summary = {
    totalExercises: exercises.length,
    withImages: exercises.filter(e => e.imageUrl).length,
    withVideos: exercises.filter(e => e.videoUrl).length,
    muscles, equipment, categories,
    scrapedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  // ── Step 4: generate the local HTML viewer ─────────────────────────────
  buildViewer(exercises, summary);

  await browser.close();
  console.log('\nDone! Open nasm-exercises/index.html in your browser to explore.');
}

// ─── HTML viewer builder ────────────────────────────────────────────────────
function buildViewer(exercises, summary) {
  const exercisesJson = JSON.stringify(exercises);

  const allMuscles   = Object.keys(summary.muscles).sort();
  const allEquipment = Object.keys(summary.equipment).sort();
  const allCategories = Object.keys(summary.categories).sort();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NASM Exercise Library</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --card: #20243a;
    --accent: #e85d26; --accent2: #f7941d;
    --text: #e8eaf0; --muted: #8b90a8; --border: #2e3250;
    --radius: 10px; --gap: 16px;
  }
  body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
  a { color: var(--accent2); text-decoration: none; }

  /* Layout */
  .app { display: flex; min-height: 100vh; }
  .sidebar { width: 260px; min-height: 100vh; background: var(--surface); border-right: 1px solid var(--border); padding: 20px 16px; flex-shrink: 0; overflow-y: auto; position: sticky; top: 0; height: 100vh; }
  .main { flex: 1; padding: 24px; overflow: auto; }

  /* Header */
  .header { margin-bottom: 20px; }
  .header h1 { font-size: 1.6rem; font-weight: 700; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .header .stats { color: var(--muted); font-size: .85rem; margin-top: 4px; }

  /* Search */
  .search-wrap { margin-bottom: 20px; }
  .search-wrap input {
    width: 100%; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text); font-size: 1rem; outline: none;
    transition: border-color .2s;
  }
  .search-wrap input:focus { border-color: var(--accent); }

  /* Filter sidebar */
  .sidebar h2 { font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; margin-top: 18px; }
  .sidebar h2:first-child { margin-top: 0; }
  .filter-group { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
  .filter-group label { display: flex; align-items: center; gap: 8px; font-size: .83rem; cursor: pointer; padding: 3px 0; color: var(--muted); transition: color .15s; }
  .filter-group label:hover { color: var(--text); }
  .filter-group input[type="checkbox"] { accent-color: var(--accent); width: 14px; height: 14px; flex-shrink: 0; }
  .filter-group label.active { color: var(--text); }
  .clear-btn { background: none; border: 1px solid var(--border); color: var(--muted); border-radius: 6px; padding: 5px 12px; font-size: .78rem; cursor: pointer; margin-top: 18px; width: 100%; transition: all .2s; }
  .clear-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--gap); }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    overflow: hidden; cursor: pointer; transition: transform .15s, border-color .15s, box-shadow .15s;
  }
  .card:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 8px 24px rgba(232,93,38,.15); }
  .card-img { width: 100%; aspect-ratio: 16/9; object-fit: cover; background: var(--surface); display: block; }
  .card-img-placeholder { width: 100%; aspect-ratio: 16/9; background: linear-gradient(135deg, #1e2238, #252a42); display: flex; align-items: center; justify-content: center; font-size: 2rem; }
  .card-body { padding: 12px; }
  .card-name { font-weight: 600; font-size: .92rem; margin-bottom: 6px; line-height: 1.3; }
  .tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { font-size: .68rem; padding: 2px 7px; border-radius: 20px; background: rgba(232,93,38,.15); color: var(--accent2); border: 1px solid rgba(232,93,38,.25); white-space: nowrap; }
  .tag.muscle { background: rgba(74,120,238,.15); color: #7ba4ff; border-color: rgba(74,120,238,.25); }
  .has-video::after { content: '▶'; position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,.6); border-radius: 50%; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; font-size: .7rem; padding-left: 2px; }
  .card { position: relative; }

  /* Modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.8); z-index: 100; display: none; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(4px); }
  .modal-overlay.open { display: flex; }
  .modal { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; max-width: 720px; width: 100%; max-height: 90vh; overflow-y: auto; }
  .modal-header { padding: 20px 24px 0; display: flex; justify-content: space-between; align-items: start; }
  .modal-title { font-size: 1.3rem; font-weight: 700; line-height: 1.3; max-width: 560px; }
  .modal-close { background: var(--card); border: 1px solid var(--border); color: var(--text); width: 32px; height: 32px; border-radius: 50%; cursor: pointer; font-size: 1.1rem; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
  .modal-body { padding: 16px 24px 24px; }
  .modal-img { width: 100%; max-height: 320px; object-fit: contain; background: var(--card); border-radius: 10px; margin-bottom: 16px; }
  .modal-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .meta-group { background: var(--card); border-radius: 8px; padding: 10px 14px; flex: 1; min-width: 180px; }
  .meta-group h4 { font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 6px; }
  .meta-group p { font-size: .85rem; color: var(--text); }
  .modal-desc { color: var(--muted); font-size: .9rem; line-height: 1.6; margin-bottom: 16px; }
  .modal-steps { padding-left: 20px; }
  .modal-steps li { font-size: .88rem; line-height: 1.6; color: var(--text); margin-bottom: 8px; }
  .modal-steps li::marker { color: var(--accent); }
  .modal-link { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; color: var(--accent2); font-size: .85rem; border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; transition: border-color .2s; }
  .modal-link:hover { border-color: var(--accent2); }
  .section-title { font-size: .8rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 16px 0 8px; }

  /* Empty state */
  .empty { text-align: center; padding: 60px 20px; color: var(--muted); }
  .empty svg { margin-bottom: 16px; opacity: .4; }

  /* Count badge */
  .count-badge { background: var(--accent); color: #fff; font-size: .72rem; font-weight: 700; padding: 1px 7px; border-radius: 20px; margin-left: auto; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<div class="app">

  <!-- Sidebar -->
  <aside class="sidebar">
    <h1 style="font-size:1.1rem;font-weight:700;margin-bottom:4px;color:var(--text)">NASM Exercise Library</h1>
    <p style="font-size:.75rem;color:var(--muted);margin-bottom:20px">Local offline viewer</p>

    <h2>Equipment</h2>
    <div class="filter-group" id="equipmentFilters"></div>

    <h2>Primary Muscles</h2>
    <div class="filter-group" id="muscleFilters"></div>

    <h2>Category</h2>
    <div class="filter-group" id="categoryFilters"></div>

    <h2>Extras</h2>
    <div class="filter-group">
      <label><input type="checkbox" id="filterHasVideo"> Has video</label>
      <label><input type="checkbox" id="filterHasImage"> Has image</label>
    </div>

    <button class="clear-btn" onclick="clearFilters()">Clear all filters</button>
  </aside>

  <!-- Main -->
  <main class="main">
    <div class="header">
      <h1>Exercise Library</h1>
      <p class="stats" id="countDisplay"></p>
    </div>
    <div class="search-wrap">
      <input type="text" id="searchInput" placeholder="Search exercises, muscles, equipment…" autocomplete="off">
    </div>
    <div class="grid" id="grid"></div>
    <div class="empty" id="emptyState" style="display:none">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      <p>No exercises match your filters.</p>
    </div>
  </main>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal" onclick="closeModal(event)">
  <div class="modal" id="modalContent">
    <div class="modal-header">
      <h2 class="modal-title" id="modalTitle"></h2>
      <button class="modal-close" onclick="closeModalDirect()">✕</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
const EXERCISES = ${exercisesJson};

const state = {
  search: '',
  equipment: new Set(),
  muscles: new Set(),
  categories: new Set(),
  hasVideo: false,
  hasImage: false,
};

// Build sidebar filters
function buildFilters() {
  const equipmentSet = new Set();
  const muscleSet = new Set();
  const categorySet = new Set();
  EXERCISES.forEach(e => {
    e.equipment.forEach(eq => { if (eq) equipmentSet.add(eq); });
    [...(e.primaryMuscles||[]), ...(e.secondaryMuscles||[])].forEach(m => { if (m) muscleSet.add(m); });
    if (e.category) categorySet.add(e.category);
  });

  buildFilterGroup('equipmentFilters', [...equipmentSet].sort(), state.equipment);
  buildFilterGroup('muscleFilters', [...muscleSet].sort(), state.muscles);
  buildFilterGroup('categoryFilters', [...categorySet].sort(), state.categories);
}

function buildFilterGroup(containerId, items, stateSet) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  items.forEach(item => {
    const label = document.createElement('label');
    const count = EXERCISES.filter(e => {
      if (containerId === 'equipmentFilters') return e.equipment.includes(item);
      if (containerId === 'muscleFilters') return [...(e.primaryMuscles||[]), ...(e.secondaryMuscles||[])].includes(item);
      return e.category === item;
    }).length;
    label.innerHTML = \`<input type="checkbox" value="\${escHtml(item)}"> \${escHtml(item)} <span class="count-badge">\${count}</span>\`;
    const cb = label.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) stateSet.add(item); else stateSet.delete(item);
      render();
    });
    container.appendChild(label);
  });
}

function clearFilters() {
  state.equipment.clear(); state.muscles.clear(); state.categories.clear();
  state.hasVideo = false; state.hasImage = false;
  state.search = '';
  document.getElementById('searchInput').value = '';
  document.getElementById('filterHasVideo').checked = false;
  document.getElementById('filterHasImage').checked = false;
  document.querySelectorAll('.filter-group input[type="checkbox"]').forEach(cb => cb.checked = false);
  render();
}

function filter() {
  return EXERCISES.filter(e => {
    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = [e.name, e.description, ...(e.primaryMuscles||[]), ...(e.secondaryMuscles||[]), ...e.equipment, e.category].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.equipment.size) {
      if (!e.equipment.some(eq => state.equipment.has(eq))) return false;
    }
    if (state.muscles.size) {
      const all = [...(e.primaryMuscles||[]), ...(e.secondaryMuscles||[])];
      if (!all.some(m => state.muscles.has(m))) return false;
    }
    if (state.categories.size && !state.categories.has(e.category)) return false;
    if (state.hasVideo && !e.videoUrl) return false;
    if (state.hasImage && !e.imageUrl && !e.localImage) return false;
    return true;
  });
}

function render() {
  const results = filter();
  const grid = document.getElementById('grid');
  const empty = document.getElementById('emptyState');
  const countEl = document.getElementById('countDisplay');
  countEl.textContent = \`\${results.length} of \${EXERCISES.length} exercises\`;

  if (!results.length) { grid.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  grid.innerHTML = results.map((e, i) => {
    const imgSrc = e.localImage || e.imageUrl;
    const imgEl  = imgSrc
      ? \`<img class="card-img" src="\${escHtml(imgSrc)}" alt="\${escHtml(e.name)}" loading="lazy" onerror="this.style.display='none'">\`
      : \`<div class="card-img-placeholder">💪</div>\`;
    const muscleTags = [...(e.primaryMuscles||[])].slice(0,3).map(m => \`<span class="tag muscle">\${escHtml(m)}</span>\`).join('');
    const eqTags     = e.equipment.slice(0,2).map(eq => \`<span class="tag">\${escHtml(eq)}</span>\`).join('');
    return \`<div class="card\${e.videoUrl ? ' has-video' : ''}" onclick="openModal(\${i})">
      \${imgEl}
      <div class="card-body">
        <div class="card-name">\${escHtml(e.name || e.url.split('/').pop())}</div>
        <div class="tags">\${muscleTags}\${eqTags}</div>
      </div>
    </div>\`;
  }).join('');

  // store filtered indices for modal navigation
  window._filtered = results;
}

function openModal(cardIndex) {
  const e = window._filtered ? window._filtered[cardIndex] : EXERCISES[cardIndex];
  if (!e) return;

  document.getElementById('modalTitle').textContent = e.name || e.url.split('/').pop();
  const imgSrc = e.localImage || e.imageUrl;

  let bodyHtml = '';
  if (imgSrc) {
    bodyHtml += \`<img class="modal-img" src="\${escHtml(imgSrc)}" alt="\${escHtml(e.name)}" onerror="this.remove()">\`;
  }

  // meta
  bodyHtml += '<div class="modal-meta">';
  if ((e.primaryMuscles||[]).length) {
    bodyHtml += \`<div class="meta-group"><h4>Primary Muscles</h4><p>\${escHtml(e.primaryMuscles.join(', '))}</p></div>\`;
  }
  if ((e.secondaryMuscles||[]).length) {
    bodyHtml += \`<div class="meta-group"><h4>Secondary Muscles</h4><p>\${escHtml(e.secondaryMuscles.join(', '))}</p></div>\`;
  }
  if (e.equipment.length) {
    bodyHtml += \`<div class="meta-group"><h4>Equipment</h4><p>\${escHtml(e.equipment.join(', '))}</p></div>\`;
  }
  if (e.category) {
    bodyHtml += \`<div class="meta-group"><h4>Category</h4><p>\${escHtml(e.category)}</p></div>\`;
  }
  bodyHtml += '</div>';

  if (e.description) {
    bodyHtml += \`<p class="modal-desc">\${escHtml(e.description)}</p>\`;
  }

  if ((e.instructions||[]).length) {
    bodyHtml += '<p class="section-title">Instructions</p><ol class="modal-steps">';
    e.instructions.forEach(step => { bodyHtml += \`<li>\${escHtml(step)}</li>\`; });
    bodyHtml += '</ol>';
  }

  if (e.videoUrl) {
    bodyHtml += \`<p class="section-title">Video</p><a href="\${escHtml(e.videoUrl)}" target="_blank" class="modal-link">▶ Watch Video</a>\`;
  }

  bodyHtml += \`<a href="\${escHtml(e.url)}" target="_blank" class="modal-link" style="margin-left:8px">↗ View on NASM</a>\`;

  document.getElementById('modalBody').innerHTML = bodyHtml;
  document.getElementById('modal').classList.add('open');
}

function closeModal(e) { if (e.target === document.getElementById('modal')) closeModalDirect(); }
function closeModalDirect() { document.getElementById('modal').classList.remove('open'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalDirect(); });

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Wire up inputs
document.getElementById('searchInput').addEventListener('input', e => { state.search = e.target.value.trim(); render(); });
document.getElementById('filterHasVideo').addEventListener('change', e => { state.hasVideo = e.target.checked; render(); });
document.getElementById('filterHasImage').addEventListener('change', e => { state.hasImage = e.target.checked; render(); });

buildFilters();
render();
</script>
</body>
</html>`;

  const viewerPath = path.join(OUT_DIR, 'index.html');
  fs.writeFileSync(viewerPath, html);
  console.log(`Viewer saved to nasm-exercises/index.html`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
