// RENDER — turn the assembled book into a self-contained static HTML site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { analyzeReview } from './review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function copyImages(book, outDir) {
  const imgDir = path.join(outDir, 'assets', 'img');
  fs.mkdirSync(imgDir, { recursive: true });
  const map = new Map(); // abs source path -> site-relative url
  const all = [];
  for (const doc of book.documents) for (const s of doc.sections) all.push(...(s.linkedImages || []));
  all.push(...book.orphanImages);
  for (const im of all) {
    if (map.has(im.path)) continue;
    const dest = `${im.hash}${im.ext}`;
    try { fs.copyFileSync(im.path, path.join(imgDir, dest)); map.set(im.path, `assets/img/${dest}`); }
    catch { /* skip unreadable */ }
  }
  return map;
}

// Rewrite a markdown file's relative image refs to copied-asset URLs, then render to HTML.
function renderSection(section, imgMap) {
  let body;
  try { body = fs.readFileSync(section.path, 'utf8'); } catch { return '<p><em>(source unavailable)</em></p>'; }
  // Strip a leading H1 (we render our own section heading) to avoid duplication.
  body = body.replace(/^\s*#\s+.+\n/, '');
  const dir = path.dirname(section.path);
  body = body.replace(/(!\[[^\]]*\]\()([^)\s]+)([^)]*\))/g, (m, pre, ref, post) => {
    if (/^https?:\/\//.test(ref)) return m;
    const abs = path.resolve(dir, ref);
    const url = imgMap.get(abs);
    return url ? `${pre}${url}${post}` : m;
  });
  return marked.parse(body);
}

function shell(title, subtitle, nav, content) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="assets/style.css">
</head><body>
<aside class="sidebar">
  <div class="brand"><strong>${subtitle.split('—')[0] || title}</strong><span>${subtitle}</span></div>
  <nav>${nav}</nav>
  <div class="built">Built by DocForge</div>
</aside>
<main class="content">${content}</main>
</body></html>`;
}

let SCREENS = []; // captured product screens, set in render()
let REVIEW = null; // coverage analysis, set in render()

function navHtml(book, currentId, gen) {
  const items = [`<a class="${currentId === 'index' ? 'active' : ''}" href="index.html">Overview</a>`];
  if (REVIEW) items.push(`<a class="${currentId === 'review' ? 'active' : ''}" href="review.html">Review Dashboard <span class="navpill ${REVIEW.coverage >= 70 ? 'ok' : REVIEW.coverage >= 40 ? 'warn' : 'bad'}">${REVIEW.coverage}%</span></a>`);
  if (gen) items.push(`<a class="${currentId === gen.doc.id ? 'active' : ''}" href="${gen.doc.id}.html">${gen.doc.title}</a>`);
  for (const doc of book.documents) {
    const active = currentId === doc.id ? 'active' : '';
    items.push(`<a class="${active}" href="${doc.id}.html">${doc.title}</a>`);
  }
  if (SCREENS.length) {
    items.push(`<a class="${currentId === 'product-screens' ? 'active' : ''}" href="product-screens.html">Product Screens</a>`);
  }
  if (book.orphanImages.length) {
    items.push(`<a class="${currentId === 'media' ? 'active' : ''}" href="media.html">Screens &amp; Media</a>`);
  }
  return items.join('');
}

export function render(book, cfg, gen) {
  const outDir = cfg.output;
  fs.mkdirSync(outDir, { recursive: true });
  const imgMap = copyImages(book, outDir);

  // Fold in product screens captured by `docforge capture` (if any).
  SCREENS = [];
  try { SCREENS = JSON.parse(fs.readFileSync(path.join(outDir, 'screens.json'), 'utf8')); } catch { /* none */ }

  // Coverage analysis (attaches per-section status used for inline badges below).
  REVIEW = analyzeReview(book, gen, SCREENS, { linkScope: cfg.linkScope });
  console.log(`        review: ${REVIEW.coverage}% coverage · ${REVIEW.gapCount} gaps (${REVIEW.thin.length} thin/stub, ${REVIEW.undocumentedEntities.length} undoc'd entities, ${REVIEW.reposWithoutDocs.length} undoc'd repos)`);

  // Generated System Architecture page (synthesized SVG diagrams + stack matrix).
  if (gen) renderGeneratedDoc(gen, book, cfg, outDir);
  if (SCREENS.length) renderProductScreens(SCREENS, book, cfg, gen, outDir);
  renderReview(REVIEW, book, cfg, gen, outDir);

  // style
  fs.copyFileSync(path.join(__dirname, '..', 'assets', 'style.css'), path.join(outDir, 'assets', 'style.css'));

  // Optional, opt-in: attach a captured screen to a doc section by title match, for inline embedding.
  // OFF by default — crude title matching collides on generic words (e.g. a "Temperature monitoring"
  // screen landing under an infra "Monitoring & Observability" section), so it's only on when a
  // config explicitly sets embedScreens:true. Screens always appear in the Product Screens gallery.
  const screenMatches = (SCREENS.length && cfg.embedScreens === true)
    ? matchScreensToSections(SCREENS, book) : new Map();

  // Per-document pages
  for (const doc of book.documents) {
    let inner = `<header class="doc-head"><h1>${doc.title}</h1><p class="aud">${doc.audience}</p><p class="blurb">${doc.blurb || ''}</p></header>`;
    inner += `<nav class="toc"><strong>On this page</strong><ul>` +
      doc.sections.map(s => `<li><a href="#${slug(s.repo + '-' + s.title)}">${s.title} <small>${s.repo}</small></a></li>`).join('') +
      `</ul></nav>`;
    for (const s of doc.sections) {
      const rv = s._review || {};
      const badge = rv.status ? `<span class="badge ${rv.status}">${rv.status}${rv.wc != null ? ` · ${rv.wc}w` : ''}</span>` : '';
      const secId = slug(s.repo + '-' + s.title);
      const shots = screenMatches.get(secId) || [];
      const shotHtml = shots.length
        ? `<div class="gallery screens inline">` + shots.map(sc =>
            `<figure><a href="${sc.file}" target="_blank"><img loading="lazy" src="${sc.file}" alt="${sc.label}"></a>` +
            `<figcaption>${sc.label}<small>${sc.url || ''}</small></figcaption></figure>`).join('') + `</div>`
        : '';
      inner += `<section class="section" id="${secId}">` +
        `<h2>${s.title} ${badge}</h2>` +
        `<p class="src">Source: <code>${s.repo}/${s.rel}</code></p>` +
        shotHtml +
        renderSection(s, imgMap) + `</section>`;
    }
    fs.writeFileSync(path.join(outDir, `${doc.id}.html`),
      shell(`${doc.title} — ${cfg.title}`, cfg.subtitle, navHtml(book, doc.id, gen), inner));
  }

  // Overview / home
  const s = book.stats;
  let home = `<header class="doc-head"><h1>${cfg.title}</h1><p class="blurb">${cfg.subtitle}</p></header>`;
  const revCard = REVIEW ? `<a class="card" href="review.html"><h3>Review Dashboard</h3><p>Coverage, thin sections, and undocumented features for the review phase.</p><span class="meta">${REVIEW.coverage}% coverage · ${REVIEW.gapCount} gaps</span></a>` : '';
  const genCard = gen ? `<a class="card" href="${gen.doc.id}.html"><h3>${gen.doc.title}</h3><p>${gen.doc.blurb}</p><span class="meta">${gen.diagrams.length} generated diagrams</span></a>` : '';
  const scrCard = SCREENS.length ? `<a class="card" href="product-screens.html"><h3>Product Screens</h3><p>Live UI screenshots captured from the running apps.</p><span class="meta">${SCREENS.length} screens</span></a>` : '';
  home += `<div class="cards">` + revCard + genCard + scrCard + book.documents.map(d =>
    `<a class="card" href="${d.id}.html"><h3>${d.title}</h3><p>${d.blurb || ''}</p>` +
    `<span class="meta">${d.sections.length} sections · ${d.audience}</span></a>`).join('') + `</div>`;
  home += `<h2>Corpus</h2><table class="stats"><tbody>` +
    `<tr><td>Markdown documents</td><td>${s.markdown}</td></tr>` +
    `<tr><td>Images / screens</td><td>${s.images} (${s.referencedImages} referenced, ${s.orphanImages} orphan)</td></tr>` +
    `<tr><td>Other material</td><td>${s.other}</td></tr>` +
    `<tr><td>Output documents</td><td>${s.documents}</td></tr></tbody></table>`;
  home += `<h2>By repository</h2><table class="stats"><tbody>` +
    Object.entries(s.byRepo).sort((a, b) => b[1] - a[1]).map(([r, c]) => `<tr><td>${r}</td><td>${c} docs</td></tr>`).join('') +
    `</tbody></table>`;
  if (book.emptyDocs.length) {
    home += `<h2>Gaps</h2><p class="gap">No content matched: ${book.emptyDocs.join(', ')}. Add docs or adjust matchers in <code>docforge.config.json</code>.</p>`;
  }
  fs.writeFileSync(path.join(outDir, 'index.html'),
    shell(cfg.title, cfg.subtitle, navHtml(book, 'index', gen), home));

  // Media gallery for orphan screenshots
  if (book.orphanImages.length) {
    let media = `<header class="doc-head"><h1>Screens &amp; Media</h1><p class="blurb">Screenshots and images discovered in the repos but not referenced by any document. Wire them into a doc, or use as a visual index.</p></header><div class="gallery">`;
    for (const im of book.orphanImages) {
      const url = imgMap.get(im.path);
      if (!url) continue;
      media += `<figure><img loading="lazy" src="${url}" alt="${im.name}"><figcaption>${im.name}<small>${im.repo}</small></figcaption></figure>`;
    }
    media += `</div>`;
    fs.writeFileSync(path.join(outDir, 'media.html'),
      shell(`Screens & Media — ${cfg.title}`, cfg.subtitle, navHtml(book, 'media', gen), media));
  }

  return { outDir, review: REVIEW };
}

// Build the generated "System Architecture" page: write standalone SVG files + inline them,
// plus a tech-stack matrix table sourced from the scan.
function renderGeneratedDoc(gen, book, cfg, outDir) {
  const dir = path.join(outDir, 'assets', 'diagrams');
  fs.mkdirSync(dir, { recursive: true });
  let inner = `<header class="doc-head"><h1>${gen.doc.title}</h1><p class="aud">${gen.doc.audience}</p><p class="blurb">${gen.doc.blurb}</p></header>`;

  for (const d of gen.diagrams) {
    const file = `${d.key}.svg`;
    fs.writeFileSync(path.join(dir, file), d.svg);
    inner += `<section class="section figure">` +
      `<h2>${d.title}</h2>` +
      `<div class="diagram">${d.svg}</div>` +
      `<p class="src">${marked.parseInline(d.note)} · <a href="assets/diagrams/${file}" download>download SVG</a></p>` +
      `</section>`;
  }

  // Tech-stack matrix from the scan.
  inner += `<section class="section"><h2>Tech-stack matrix</h2>` +
    `<table class="stats wide"><thead><tr><th>Repository</th><th>Language</th><th>Framework</th><th>Runtime</th><th>Infra used</th></tr></thead><tbody>` +
    gen.scan.repos.map(r =>
      `<tr><td><code>${r.repo}</code></td><td>${r.lang || '—'}</td><td>${r.framework}</td><td>${r.runtime || '—'}</td>` +
      `<td>${(r.infra || []).map(i => i.name).join(', ') || (r.badges || []).join(', ') || '—'}</td></tr>`).join('') +
    `</tbody></table></section>`;

  fs.writeFileSync(path.join(outDir, `${gen.doc.id}.html`),
    shell(`${gen.doc.title} — ${cfg.title}`, cfg.subtitle, navHtml(book, gen.doc.id, gen), inner));
}

// Build the "Product Screens" page from screenshots captured by `docforge capture`,
// grouped by app, each a real rendered UI screen of the running product.
// Tokenise a title/label into meaningful, singular, lower-case words for matching.
const SCREEN_STOP = new Set(['guide', 'manual', 'feature', 'page', 'overview', 'reference',
  'home', 'the', 'and', 'for', 'view', 'list', 'setup', 'new', 'old', 'all', 'dashboard',
  // generic infra/dev words that collide across unrelated UI pages and docs
  'monitoring', 'observability', 'integration', 'management', 'platform', 'system', 'service',
  'configuration', 'config', 'deployment', 'performance', 'analytics', 'processing', 'automation',
  'data', 'api', 'web', 'app', 'mobile', 'security', 'testing', 'architecture']);
function screenTokens(s) {
  return [...new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .map(t => t.replace(/s$/, '')).filter(t => t.length >= 3 && !SCREEN_STOP.has(t)))];
}

// Map each screen to the doc section whose title shares the most tokens with the screen's label.
// Returns Map<sectionSlug, screen[]>. Screens with no shared token stay gallery-only.
function matchScreensToSections(screens, book) {
  const sections = [];
  for (const doc of book.documents) for (const s of doc.sections)
    sections.push({ slug: slug(s.repo + '-' + s.title), toks: screenTokens(s.title) });
  const map = new Map();
  for (const sc of screens) {
    const stoks = screenTokens(sc.label);
    let best = null, bestScore = 0;
    for (const sec of sections) {
      const score = sec.toks.filter(t => stoks.includes(t)).length;
      if (score > bestScore) { bestScore = score; best = sec; }
    }
    if (best && bestScore >= 1) {
      if (!map.has(best.slug)) map.set(best.slug, []);
      map.get(best.slug).push(sc);
    }
  }
  return map;
}

// Screen-by-screen walkthrough: every captured page under its own heading with a full-width
// screenshot — labelled by the page it actually is (from capture), so it's correct by construction.
function renderProductScreens(screens, book, cfg, gen, outDir) {
  const groups = {};
  for (const s of screens) (groups[s.name] ||= []).push(s);
  let inner = `<header class="doc-head"><h1>Product Screens</h1><p class="aud">End users & operators</p>` +
    `<p class="blurb">A screen-by-screen walkthrough of the live product — ${screens.length} pages captured headlessly from the running apps. Click any image for full size.</p></header>`;
  // Jump-to nav across the captured apps.
  inner += `<nav class="toc"><strong>On this page</strong><ul>` +
    Object.entries(groups).map(([app, shots]) => `<li><a href="#${slug(app)}">${app} <small>${shots.length} screens</small></a></li>`).join('') +
    `</ul></nav>`;
  for (const [app, shots] of Object.entries(groups)) {
    inner += `<section class="section" id="${slug(app)}"><h2>${app}</h2><div class="screenwalk">`;
    for (const s of shots) {
      inner += `<figure class="shot"><h3 id="${slug(app + '-' + s.label)}">${s.label}</h3>` +
        `<a href="${s.file}" target="_blank"><img loading="lazy" src="${s.file}" alt="${app} — ${s.label}"></a>` +
        `<figcaption>${s.url || ''}${s.width ? ` · ${s.width}×${s.height}` : ''}</figcaption></figure>`;
    }
    inner += `</div></section>`;
  }
  fs.writeFileSync(path.join(outDir, 'product-screens.html'),
    shell(`Product Screens — ${cfg.title}`, cfg.subtitle, navHtml(book, 'product-screens', gen), inner));
}

// Build the Review Dashboard: coverage score, per-document bars, and a gap checklist for reviewers.
function renderReview(rv, book, cfg, gen, outDir) {
  const klass = rv.coverage >= 70 ? 'ok' : rv.coverage >= 40 ? 'warn' : 'bad';
  let inner = `<header class="doc-head"><h1>Review Dashboard</h1><p class="aud">For the review phase</p>` +
    `<p class="blurb">Documentation coverage and the gaps to close before sign-off. Auto-generated from the corpus.</p></header>`;

  // Headline score
  inner += `<div class="score ${klass}"><div class="num">${rv.coverage}%</div><div class="lbl">section coverage` +
    `<small>${rv.totals.complete} complete · ${rv.totals.thin} thin · ${rv.totals.stub} stub · ${rv.gapCount} total gaps</small></div></div>`;

  // Per-document coverage bars
  inner += `<h2>Coverage by document</h2><div class="covlist">`;
  for (const [id, d] of Object.entries(rv.docStats)) {
    const pct = d.total ? Math.round((d.complete / d.total) * 100) : 0;
    inner += `<div class="covrow"><a href="${id}.html">${d.title}</a>` +
      `<div class="bar"><span class="complete" style="width:${(d.complete / d.total) * 100}%"></span>` +
      `<span class="thin" style="width:${(d.thin / d.total) * 100}%"></span>` +
      `<span class="stub" style="width:${(d.stub / d.total) * 100}%"></span></div>` +
      `<span class="pct">${pct}%</span></div>`;
  }
  inner += `</div>`;

  // Gap checklist — each item links to where the work is.
  const checklist = (title, items, render) => {
    if (!items.length) return '';
    let h = `<h2>${title} <span class="count">${items.length}</span></h2><ul class="checklist">`;
    for (const it of items) h += `<li><label><input type="checkbox"> ${render(it)}</label></li>`;
    return h + `</ul>`;
  };

  inner += checklist('Thin / stub sections', rv.thin,
    s => `<a href="${s.docId}.html#${s.anchor}">${s.title}</a> <span class="badge ${s.status}">${s.status} · ${s.wc}w</span> <small>${s.repo}/${s.rel}</small>`);
  inner += checklist('Broken links', rv.broken.flatMap(s => s.broken.map(b => ({ s, b }))),
    ({ s, b }) => `<code>${b}</code> in <a href="${s.docId}.html#${s.anchor}">${s.title}</a>`);
  inner += checklist('Data-model entities with no prose', rv.undocumentedEntities,
    e => `<code>${e}</code> — in the data model but not described in any doc`);
  inner += checklist('Captured screens with no prose', rv.undocumentedScreens,
    s => `${s.label} <small>${s.name}</small> — screenshot exists, no written page`);
  inner += checklist('Repositories with no documentation', rv.reposWithoutDocs,
    r => `<code>${r}</code> — code present, no Markdown picked up`);

  if (rv.gapCount === 0) inner += `<p class="gap">No gaps detected — every section is complete and every feature is documented. Ready for sign-off.</p>`;

  // Persist reviewer ticks locally so progress survives reloads.
  inner += `<script>(function(){var K='docforge-review-'+location.pathname;var st=JSON.parse(localStorage.getItem(K)||'{}');
    document.querySelectorAll('.checklist input').forEach(function(cb,i){cb.checked=!!st[i];cb.addEventListener('change',function(){st[i]=cb.checked;localStorage.setItem(K,JSON.stringify(st));cb.closest('li').classList.toggle('done',cb.checked);});if(cb.checked)cb.closest('li').classList.add('done');});})();</script>`;

  fs.writeFileSync(path.join(outDir, 'review.html'),
    shell(`Review Dashboard — ${cfg.title}`, cfg.subtitle, navHtml(book, 'review', gen), inner));
}
