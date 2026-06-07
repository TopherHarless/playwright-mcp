/**
 * nasm-rebuild.js
 *
 * Uses the already-captured nasm-exercises/data/api-captures.json to:
 *   1. Parse the exercises.json API response (richer data than page scraping)
 *   2. Download all exercise thumbnail images
 *   3. Rewrite nasm-exercises/data/exercises.json with clean structured data
 *   4. Rebuild nasm-exercises/index.html with difficulty + body-part filters
 *
 * Run from the playwright-mcp directory:
 *   node nasm-rebuild.js
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const OUT_DIR  = path.join(__dirname, 'nasm-exercises');
const DATA_DIR = path.join(OUT_DIR, 'data');
const IMG_DIR  = path.join(OUT_DIR, 'images');

for (const d of [OUT_DIR, DATA_DIR, IMG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
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
        file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest);
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('error', e => { file.close(); if (fs.existsSync(dest)) fs.unlinkSync(dest); reject(e); });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseSteps(description) {
  if (!description) return [];
  return description.split('\n')
    .map(l => l.replace(/^Step\s+\d+:\s*/i, '').trim())
    .filter(Boolean);
}

// YouTube video ID → high-quality thumbnail (no auth required)
function youtubeThumbnail(videoUrl) {
  if (!videoUrl) return null;
  const m = videoUrl.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? 'https://img.youtube.com/vi/' + m[1] + '/hqdefault.jpg' : null;
}

// Find an already-downloaded image for this slug (from nasm-scraper.js run)
function existingImage(slug) {
  const exts = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
  for (const ext of exts) {
    const p = path.join(IMG_DIR, slug + '.' + ext);
    if (fs.existsSync(p)) return 'images/' + slug + '.' + ext;
  }
  return null;
}

async function main() {
  const capturesPath = path.join(DATA_DIR, 'api-captures.json');
  if (!fs.existsSync(capturesPath)) {
    console.error('api-captures.json not found — run nasm-scraper.js first.');
    process.exit(1);
  }

  const captures = JSON.parse(fs.readFileSync(capturesPath, 'utf8'));
  const exercisesUrl = Object.keys(captures).find(u => u.includes('documents/exercises.json'));
  if (!exercisesUrl) {
    console.error('exercises.json not found in api-captures.json');
    process.exit(1);
  }

  const apiData = JSON.parse(captures[exercisesUrl]);
  console.log('Total exercises:', apiData.total);
  console.log('Columns:', (apiData.columns || []).join(', '));

  const exercises = apiData.data.map((raw, i) => {
    const slug      = slugify(raw['Title'] || ('exercise-' + i));
    const steps     = parseSteps(raw['Description']);
    const bodyParts = (raw['Body Part'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const equipment = (raw['Equipment'] || '').split(',').map(s => s.trim()).filter(Boolean);
    const videoUrl  = raw['Video URL'] || null;
    // prefer YouTube thumbnail (always accessible) over NASM CDN
    const thumbnailUrl = youtubeThumbnail(videoUrl);
    const localImage   = existingImage(slug); // reuse from first scraper run if present
    return {
      id: i + 1,
      slug,
      url: 'https://www.nasm.org/resource-center/exercise-library/' + slug,
      title:      raw['Title'] || '',
      difficulty: raw['Difficulty'] || '',
      equipment,
      bodyParts,
      videoUrl,
      thumbnailUrl,
      localImage,
      steps,
    };
  });

  // Download YouTube thumbnails (only for exercises that don't already have a local image)
  console.log('\nDownloading YouTube thumbnails...');
  let downloaded = 0, skipped = 0;
  for (let i = 0; i < exercises.length; i++) {
    const ex = exercises[i];
    if (ex.localImage) { skipped++; continue; } // already have it
    if (!ex.thumbnailUrl) continue;
    const dest = path.join(IMG_DIR, ex.slug + '.jpg');
    try {
      await downloadFile(ex.thumbnailUrl, dest);
      ex.localImage = 'images/' + ex.slug + '.jpg';
      downloaded++;
      process.stdout.write('  [' + (i+1) + '/' + exercises.length + '] ' + ex.slug + ' OK\n');
    } catch (e) {
      process.stdout.write('  [' + (i+1) + '/' + exercises.length + '] ' + ex.slug + ' SKIP (' + e.message + ')\n');
    }
    await sleep(100);
  }
  console.log('  Downloaded: ' + downloaded + ', reused: ' + skipped);

  fs.writeFileSync(path.join(DATA_DIR, 'exercises.json'), JSON.stringify(exercises, null, 2));
  console.log('\nSaved', exercises.length, 'exercises to data/exercises.json');

  // Summary
  const difficulties = {}, equipment = {}, bodyParts = {};
  exercises.forEach(e => {
    if (e.difficulty) difficulties[e.difficulty] = (difficulties[e.difficulty] || 0) + 1;
    e.equipment.forEach(eq => { equipment[eq] = (equipment[eq] || 0) + 1; });
    e.bodyParts.forEach(bp => { bodyParts[bp] = (bodyParts[bp] || 0) + 1; });
  });
  console.log('Difficulty:', difficulties);
  console.log('Equipment:', equipment);
  console.log('Body Parts:', bodyParts);

  fs.writeFileSync(path.join(DATA_DIR, 'summary.json'),
    JSON.stringify({ total: exercises.length, difficulties, equipment, bodyParts }, null, 2));

  buildViewer(exercises);
  buildViewer(exercises, true);
  console.log('\nDone! Open nasm-exercises/index.html in your browser.');
}

// ─── viewer ─────────────────────────────────────────────────────────────────
// NOTE: backticks inside the embedded <script> are written as \` so they don't
// close this Node.js template literal prematurely.
function buildViewer(exercises, deployMode = false) {
  const outDir = deployMode ? path.join(__dirname, 'docs') : OUT_DIR;
  if (deployMode && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const dataJson = JSON.stringify(exercises);

  const scriptSrc = [
    'const EX = ' + dataJson + ';',
    'const state = { q:"", diff:new Set(), body:new Set(), equip:new Set(), vid:false, img:false };',

    'function counts(field) {',
    '  const c = {};',
    '  EX.forEach(e => {',
    '    const vals = Array.isArray(e[field]) ? e[field] : [e[field]];',
    '    vals.forEach(v => { if(v) c[v] = (c[v]||0)+1; });',
    '  });',
    '  return c;',
    '}',

    'function buildSidebar() {',
    '  fill("fDiff",  counts("difficulty"), state.diff);',
    '  fill("fBody",  counts("bodyParts"),  state.body);',
    '  fill("fEquip", counts("equipment"),  state.equip);',
    '}',

    'function fill(id, counts, stateSet) {',
    '  const el = document.getElementById(id);',
    '  el.innerHTML = Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(function(entry) {',
    '    const val = entry[0], cnt = entry[1];',
    '    return \'<label><input type="checkbox" value="\' + esc(val) + \'"> \' + esc(val) + \' <span class="count">\' + cnt + \'</span></label>\';',
    '  }).join("");',
    '  el.querySelectorAll("input").forEach(function(cb) {',
    '    cb.addEventListener("change", function() {',
    '      cb.checked ? stateSet.add(cb.value) : stateSet.delete(cb.value);',
    '      render();',
    '    });',
    '  });',
    '}',

    'function filtered() {',
    '  return EX.filter(function(e) {',
    '    if (state.q) {',
    '      const q = state.q.toLowerCase();',
    '      if (![e.title, e.difficulty].concat(e.bodyParts, e.equipment).join(" ").toLowerCase().includes(q)) return false;',
    '    }',
    '    if (state.diff.size && !state.diff.has(e.difficulty)) return false;',
    '    if (state.body.size && !e.bodyParts.some(function(b){return state.body.has(b);})) return false;',
    '    if (state.equip.size && !e.equipment.some(function(q){return state.equip.has(q);})) return false;',
    '    if (state.vid && !e.videoUrl) return false;',
    '    if (state.img && !e.localImage && !e.thumbnailUrl) return false;',
    '    return true;',
    '  });',
    '}',

    'var _vis = [];',
    'function render() {',
    '  _vis = filtered();',
    '  const grid = document.getElementById("grid");',
    '  document.getElementById("countEl").textContent = _vis.length + " of " + EX.length + " exercises";',
    '  document.getElementById("empty").style.display = _vis.length ? "none" : "block";',
    '  grid.innerHTML = _vis.map(function(e, i) {',
    '    const img = ' + (deployMode ? 'e.thumbnailUrl;' : 'e.localImage || e.thumbnailUrl;'),
    '    const imgEl = img',
    '      ? \'<img class="card-img" src="\' + esc(img) + \'" loading="lazy" onerror="this.remove()">\' ',
    '      : \'<div class="card-placeholder">\u{1F4AA}</div>\';',
    '    const diffCls = "tag-diff " + (e.difficulty || "");',
    '    const bpTags  = e.bodyParts.slice(0,2).map(function(b){ return \'<span class="tag tag-bp">\' + esc(b) + \'</span>\'; }).join("");',
    '    const eqTags  = e.equipment.slice(0,2).map(function(q){ return \'<span class="tag tag-eq">\' + esc(q) + \'</span>\'; }).join("");',
    '    const diffTag = e.difficulty ? \'<span class="tag \' + diffCls + \'">\' + esc(e.difficulty) + \'</span>\' : "";',
    '    const vidBadge = e.videoUrl ? \'<div class="vid-badge">▶</div>\' : "";',
    '    return \'<div class="card" onclick="openModal(\' + i + \')">\'  + imgEl + vidBadge',
    '      + \'<div class="card-body"><div class="card-title">\' + esc(e.title) + \'</div>\'',
    '      + \'<div class="tags">\' + diffTag + bpTags + eqTags + \'</div></div></div>\';',
    '  }).join("");',
    '}',

    'function openModal(idx) {',
    '  const e = _vis[idx];',
    '  document.getElementById("mTitle").textContent = e.title;',
    '  const img = e.localImage || e.thumbnailUrl;',
    '  var html = img ? \'<img class="modal-img" src="\' + esc(img) + \'" onerror="this.remove()">\' : "";',
    '  html += \'<div class="meta-row">\';',
    '  if (e.difficulty) html += \'<div class="meta-chip"><h4>Difficulty</h4><p>\' + esc(e.difficulty) + \'</p></div>\';',
    '  if (e.bodyParts.length) html += \'<div class="meta-chip"><h4>Muscles / Body Part</h4><p>\' + esc(e.bodyParts.join(", ")) + \'</p></div>\';',
    '  if (e.equipment.length) html += \'<div class="meta-chip"><h4>Equipment</h4><p>\' + esc(e.equipment.join(", ")) + \'</p></div>\';',
    '  html += \'</div>\';',
    '  if (e.steps && e.steps.length) {',
    '    html += \'<div class="steps-title">Instructions</div><ol class="steps">\';',
    '    e.steps.forEach(function(s) { html += "<li>" + esc(s) + "</li>"; });',
    '    html += \'</ol>\';',
    '  }',
    '  html += \'<div class="modal-links">\';',
    '  if (e.videoUrl) html += \'<a class="modal-link" href="\' + esc(e.videoUrl) + \'" target="_blank">▶ Watch on YouTube</a>\';',
    '  html += \'<a class="modal-link" href="\' + esc(e.url) + \'" target="_blank">↗ View on NASM</a>\';',
    '  html += \'</div>\';',
    '  document.getElementById("mBody").innerHTML = html;',
    '  document.getElementById("overlay").classList.add("open");',
    '}',

    'function closeModal(ev) { if (ev.target === document.getElementById("overlay")) closeModalDirect(); }',
    'function closeModalDirect() { document.getElementById("overlay").classList.remove("open"); }',
    'document.addEventListener("keydown", function(e) { if (e.key === "Escape") closeModalDirect(); });',

    'function clearAll() {',
    '  state.q = ""; state.diff.clear(); state.body.clear(); state.equip.clear();',
    '  state.vid = false; state.img = false;',
    '  document.getElementById("q").value = "";',
    '  document.getElementById("chkVideo").checked = false;',
    '  document.getElementById("chkImg").checked = false;',
    '  document.querySelectorAll(".filter-list input[type=checkbox]").forEach(function(c){c.checked=false;});',
    '  render();',
    '}',

    'function esc(s) {',
    '  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");',
    '}',

    'document.getElementById("q").addEventListener("input", function(e) { state.q = e.target.value.trim(); render(); });',
    'document.getElementById("chkVideo").addEventListener("change", function(e) { state.vid = e.target.checked; render(); });',
    'document.getElementById("chkImg").addEventListener("change", function(e) { state.img = e.target.checked; render(); });',
    'buildSidebar();',
    'render();',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NASM Exercise Library</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#1a1d27;--card:#20243a;
  --accent:#e85d26;--accent2:#f7941d;
  --text:#e8eaf0;--muted:#8b90a8;--border:#2e3250;
}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
.app{display:flex;min-height:100vh}
.sidebar{width:240px;min-height:100vh;background:var(--surface);border-right:1px solid var(--border);padding:16px;flex-shrink:0;overflow-y:auto;position:sticky;top:0;height:100vh}
.main{flex:1;padding:20px;overflow:auto}
.logo{font-size:1rem;font-weight:700;color:var(--text);margin-bottom:2px}
.logo span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{font-size:.72rem;color:var(--muted);margin-bottom:18px}
.search input{width:100%;padding:9px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;outline:none;margin-bottom:16px;transition:border-color .2s}
.search input:focus{border-color:var(--accent)}
.filter-section{margin-bottom:14px}
.filter-label{font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:7px}
.filter-list{display:flex;flex-direction:column;gap:3px;max-height:180px;overflow-y:auto}
.filter-list label{display:flex;align-items:center;gap:7px;font-size:.8rem;cursor:pointer;padding:3px 4px;border-radius:5px;color:var(--muted);transition:all .15s}
.filter-list label:hover{color:var(--text);background:rgba(255,255,255,.04)}
.filter-list input[type=checkbox]{accent-color:var(--accent);width:13px;height:13px;flex-shrink:0}
.count{margin-left:auto;font-size:.68rem;background:var(--border);border-radius:10px;padding:1px 6px;color:var(--muted)}
.clear{width:100%;margin-top:14px;padding:7px;background:none;border:1px solid var(--border);color:var(--muted);border-radius:7px;cursor:pointer;font-size:.78rem;transition:all .2s}
.clear:hover{border-color:var(--accent);color:var(--accent)}
.header{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
.header h1{font-size:1.4rem;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.count-display{font-size:.8rem;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;cursor:pointer;transition:transform .15s,border-color .15s,box-shadow .15s;position:relative}
.card:hover{transform:translateY(-3px);border-color:var(--accent);box-shadow:0 8px 24px rgba(232,93,38,.15)}
.card-img{width:100%;aspect-ratio:16/9;object-fit:cover;background:var(--surface);display:block}
.card-placeholder{width:100%;aspect-ratio:16/9;background:linear-gradient(135deg,#1e2238,#252a42);display:flex;align-items:center;justify-content:center;font-size:2rem}
.card-body{padding:11px}
.card-title{font-weight:600;font-size:.88rem;margin-bottom:7px;line-height:1.3}
.tags{display:flex;flex-wrap:wrap;gap:3px}
.tag{font-size:.65rem;padding:2px 7px;border-radius:20px;border:1px solid;white-space:nowrap}
.tag-eq{background:rgba(232,93,38,.12);color:var(--accent2);border-color:rgba(232,93,38,.22)}
.tag-bp{background:rgba(74,120,238,.12);color:#7ba4ff;border-color:rgba(74,120,238,.22)}
.tag-diff{border:none;font-weight:600;font-size:.62rem;padding:2px 7px;border-radius:20px}
.tag-diff.Beginner{background:rgba(58,125,68,.2);color:#6bbf7a}
.tag-diff.Intermediate{background:rgba(180,83,9,.2);color:#f59e0b}
.tag-diff.Advanced{background:rgba(155,28,28,.2);color:#f87171}
.vid-badge{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.65);border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:.65rem;padding-left:2px}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:100;display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;max-width:700px;width:100%;max-height:90vh;overflow-y:auto}
.modal-head{padding:20px 22px 0;display:flex;justify-content:space-between;align-items:start;gap:12px}
.modal-title{font-size:1.25rem;font-weight:700;line-height:1.3}
.modal-close{background:var(--card);border:1px solid var(--border);color:var(--text);width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:1rem;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.modal-body{padding:14px 22px 22px}
.modal-img{width:100%;max-height:300px;object-fit:contain;background:var(--card);border-radius:9px;margin-bottom:14px}
.meta-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.meta-chip{background:var(--card);border-radius:7px;padding:8px 13px;flex:1;min-width:150px}
.meta-chip h4{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:5px}
.meta-chip p{font-size:.82rem}
.steps-title{font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 8px}
.steps{padding-left:18px}
.steps li{font-size:.85rem;line-height:1.65;color:var(--text);margin-bottom:7px}
.steps li::marker{color:var(--accent)}
.modal-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.modal-link{display:inline-flex;align-items:center;gap:6px;color:var(--accent2);font-size:.82rem;border:1px solid var(--border);border-radius:7px;padding:7px 13px;transition:border-color .2s;text-decoration:none}
.modal-link:hover{border-color:var(--accent2)}
.empty{text-align:center;padding:60px 20px;color:var(--muted)}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<div class="app">
<aside class="sidebar">
  <div class="logo">NASM <span>Exercise Library</span></div>
  <div class="sub">75 exercises &middot; offline viewer</div>
  <div class="search"><input id="q" type="text" placeholder="Search&hellip;" autocomplete="off"></div>
  <div class="filter-section">
    <div class="filter-label">Difficulty</div>
    <div class="filter-list" id="fDiff"></div>
  </div>
  <div class="filter-section">
    <div class="filter-label">Body Part / Muscle</div>
    <div class="filter-list" id="fBody"></div>
  </div>
  <div class="filter-section">
    <div class="filter-label">Equipment</div>
    <div class="filter-list" id="fEquip"></div>
  </div>
  <div class="filter-section">
    <div class="filter-label">Media</div>
    <div class="filter-list">
      <label><input type="checkbox" id="chkVideo"> Has video</label>
      <label><input type="checkbox" id="chkImg"> Has image</label>
    </div>
  </div>
  <button class="clear" onclick="clearAll()">Clear all filters</button>
</aside>
<main class="main">
  <div class="header">
    <h1>Exercise Library</h1>
    <span class="count-display" id="countEl"></span>
  </div>
  <div class="grid" id="grid"></div>
  <div class="empty" id="empty" style="display:none">No exercises match your filters.</div>
</main>
</div>
<div class="modal-overlay" id="overlay" onclick="closeModal(event)">
  <div class="modal">
    <div class="modal-head">
      <div class="modal-title" id="mTitle"></div>
      <button class="modal-close" onclick="closeModalDirect()">&#x2715;</button>
    </div>
    <div class="modal-body" id="mBody"></div>
  </div>
</div>
<script>
${scriptSrc}
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log('Viewer written to ' + (deployMode ? 'docs/index.html' : 'nasm-exercises/index.html'));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
