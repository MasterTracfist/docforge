// ENRICH — opt-in authoring aid. Turns the review gaps (undocumented entities, thin sections) into
// CITED draft prose via Clara, written to a review file for a human to apply. It NEVER edits source
// repos and NEVER runs in `build`/the gate (which stay deterministic + dependency-free).
//
// Clara API (http://127.0.0.1:4600 by default):
//   POST /api/ask {brain,q,learn,cache} -> {ok, answer, used[], confidence, cost}   (costs money)
// Use a DEDICATED brain (not __super__) so answers + citations are scoped to this product.
import fs from 'node:fs';
import path from 'node:path';
import { discover } from './discover.js';
import { classify } from './classify.js';
import { assemble } from './assemble.js';
import { generate } from './generate.js';
import { analyzeReview } from './review.js';

const MIN_CONFIDENCE = 0.4; // below this, leave the gap for a human rather than trust the draft

async function askClara(claraUrl, brain, q, learn) {
  const r = await fetch(`${claraUrl}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brain, q, learn, cache: true }),
  });
  if (!r.ok) throw new Error(`Clara HTTP ${r.status}`);
  return r.json();
}

// Collect the questions to ask, from the same analysis the gate produces.
function questionsFor(cfg) {
  const m = discover(cfg); classify(m, cfg);
  const book = assemble(m, cfg); const gen = generate(cfg);
  const rv = analyzeReview(book, gen, [], { linkScope: cfg.linkScope });
  const qs = [
    ...rv.undocumentedEntities.map(name => ({
      kind: 'entity', target: 'docs/DATA_MODEL.md',
      q: `In the ${cfg.title}, what is the "${name}" entity/table for? Answer in one factual sentence.`,
    })),
    ...rv.thin.map(s => ({
      kind: 'thin', target: `${s.repo}/${s.rel}`,
      q: `Write a factual 2-3 sentence overview for the documentation section titled "${s.title}" in ${s.repo}.`,
    })),
  ];
  return { qs, coverage: rv.coverage, gapCount: rv.gapCount };
}

export async function enrich(cfg, opts) {
  const { qs, coverage, gapCount } = questionsFor(cfg);
  console.log(`\nDoc — enrich: ${qs.length} gap(s) to draft (coverage ${coverage}%, ${gapCount} total gaps)`);
  if (!qs.length) { console.log('  Nothing to enrich — no entity/thin gaps. ✓\n'); return; }

  const capped = qs.slice(0, opts.max);
  if (capped.length < qs.length) console.log(`  (capped to ${opts.max}; raise with --max)`);

  // Dry run: show exactly what would be asked, no Clara call, no cost.
  if (opts.dryRun) {
    console.log(`  DRY RUN — would ask brain "${opts.brain}" at ${opts.claraUrl} (no calls, no cost):`);
    for (const a of capped) console.log(`    • [${a.kind} → ${a.target}] ${a.q}`);
    console.log('');
    return;
  }

  // Clara is OPTIONAL — unreachable means no-op, never an error.
  try { await fetch(`${opts.claraUrl}/api/brains`, { signal: AbortSignal.timeout(3000) }); }
  catch { console.log(`  Clara not reachable at ${opts.claraUrl} — skipping (enrich is optional).\n`); return; }

  let cost = 0; const out = [];
  for (const a of capped) {
    try {
      const res = await askClara(opts.claraUrl, opts.brain, a.q, opts.learn);
      cost += res.cost || 0;
      const conf = res.confidence ?? 1;
      if (res.ok && res.answer && conf >= MIN_CONFIDENCE) {
        out.push({ ...a, answer: res.answer.trim(), used: res.used || [], confidence: conf });
        console.log(`  ✓ ${a.kind}: ${a.target}  (confidence ${conf})`);
      } else {
        console.log(`  – ${a.kind}: low confidence (${conf}) — left for a human`);
      }
    } catch (e) { console.log(`  ! ${a.kind}: ${e.message}`); }
  }

  const md = [`# Enrichment suggestions`, ``,
    `${out.length} cited draft(s) from Clara brain \`${opts.brain}\` for **review** — paste the ones`,
    `you trust into the target file. Nothing here was applied automatically. Clara cost: $${cost.toFixed(4)}.`, ``,
    ...out.map(o => [`## \`${o.target}\` · ${o.kind} · confidence ${o.confidence}`, ``, o.answer, ``,
      o.used?.length ? `_Sources: ${o.used.map(u => u.title || u.url || u).join('; ')}_` : `_(no citation — verify before using)_`,
      ``].join('\n'))];
  fs.mkdirSync(cfg.output, { recursive: true });
  const file = path.join(cfg.output, 'enrich-suggestions.md');
  fs.writeFileSync(file, md.join('\n'));
  console.log(`\n  ✓ ${out.length}/${capped.length} drafted → ${file}   (Clara cost $${cost.toFixed(4)})`);
  console.log(`  Review and paste what you trust; nothing was written to the source repos.\n`);
}
