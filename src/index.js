#!/usr/bin/env node
// Doc CLI — discover -> classify -> assemble -> render a complete manual from a repo corpus.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { discover } from './discover.js';
import { classify } from './classify.js';
import { assemble } from './assemble.js';
import { generate } from './generate.js';
import { render } from './render.js';
import { captureScreens } from './capture.js';
import { runWizard } from './init.js';
import { evaluateGate, reportGate } from './gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig(p) {
  const file = p || path.join(__dirname, '..', 'doc.config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function build(cfg) {
  const t0 = Date.now();
  console.log(`\nDoc — building "${cfg.title}"`);
  console.log('  [1/4] discover…');
  const manifest = discover(cfg);
  console.log(`        ${manifest.length} artifacts across ${cfg.roots.length} roots`);
  console.log('  [2/4] classify…');
  classify(manifest, cfg);
  console.log('  [3/5] assemble…');
  const book = assemble(manifest, cfg);
  console.log(`        ${book.documents.length} documents, ${book.stats.markdown} sections`);
  console.log('  [4/5] generate (scan stack → diagrams)…');
  const gen = generate(cfg);
  console.log(`        ${gen.diagrams.length} diagrams · ${gen.scan.repos.length} repos · ${gen.model.entities.length} entities`);
  console.log('  [5/5] render…');
  const { outDir, review } = render(book, cfg, gen);
  console.log(`\n  ✓ Built in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}`);
  for (const d of book.documents) console.log(`     • ${d.title}: ${d.sections.length} sections`);
  if (book.orphanImages.length) console.log(`     • Screens & Media: ${book.orphanImages.length} orphan images`);
  if (book.emptyDocs.length) console.log(`     ! gaps: ${book.emptyDocs.join(', ')}`);
  console.log(`\n  Preview:  npx doc serve   (or open ${path.join(outDir, 'index.html')})\n`);
  return { outDir, review };
}

// Merge gate thresholds from config (`gate` block) with CLI flags (flags win). The gate is only
// enforced when a coverage floor is supplied somewhere — otherwise build stays a plain render.
function resolveGate(cfg, flags) {
  const g = cfg.gate || {};
  const pick = (flag, key) => (flag !== undefined ? Number(flag) : g[key]);
  const opts = {
    minCoverage: pick(flags.minCoverage, 'minCoverage'),
    maxBroken: pick(flags.maxBroken, 'maxBroken'),
    maxGaps: pick(flags.maxGaps, 'maxGaps'),
  };
  const active = opts.minCoverage != null || flags.minCoverage !== undefined ||
    opts.maxBroken != null || opts.maxGaps != null;
  return { active, opts };
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function serve(cfg, port = 4800) {
  const root = cfg.output;
  if (!fs.existsSync(path.join(root, 'index.html'))) build(cfg);
  http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`Doc serving ${root} → http://localhost:${port}`));
}

const cmd = process.argv[2] || 'build';
const flag = (k) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : undefined; };
const configPath = flag('config') || path.join(__dirname, '..', 'doc.config.json');

// `init` is interactive and writes the config, so it must run before any config load.
if (cmd === 'init') {
  const res = await runWizard(configPath);
  if (res?.buildNow) build(res.config);
  if (res?.captureNow) {
    console.log('\nDoc — capturing product screens via headless Chrome…');
    const shots = await captureScreens(res.config, {});
    if (shots.length) build(res.config); // fold screens into the manual
  }
  if (res) console.log(`\n  Next: node src/index.js serve   →  preview at http://localhost:4800\n`);
  process.exit(0);
}

const cfg = loadConfig(configPath);

if (cmd === 'build') {
  const { review } = build(cfg);
  const gate = resolveGate(cfg, {
    minCoverage: flag('min-coverage'), maxBroken: flag('max-broken'), maxGaps: flag('max-gaps'),
  });
  if (gate.active) {
    const result = evaluateGate(review, gate.opts);
    process.exit(reportGate(result));
  }
} else if (cmd === 'serve') {
  serve(cfg, flag('port') ? Number(flag('port')) : 4800);
} else if (cmd === 'capture') {
  console.log('\nDoc — capturing product screens via headless Chrome…');
  fs.mkdirSync(cfg.output, { recursive: true });
  const shots = await captureScreens(cfg, {
    url: flag('url'), name: flag('name'), label: flag('label'),
    target: flag('target'), route: flag('route'),
  });
  console.log(`\n  ✓ captured ${shots.length} screen(s) → ${path.join(cfg.output, 'assets', 'screens')}`);
  console.log(`  Run "node src/index.js build" to fold them into the manual (Product Screens page).\n`);
} else { console.error(`Unknown command: ${cmd}. Use "init", "build", "capture", or "serve".`); process.exit(1); }
