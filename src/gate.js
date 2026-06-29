// GATE — turn the review analysis into a pass/fail CI check. `doc build --min-coverage=85`
// exits non-zero when coverage drops below the floor or broken links appear, so the manual can be
// guarded as a documentation-quality check in CI alongside lint/test.
//
// Knobs (CLI flag overrides config.gate):
//   minCoverage   section coverage % floor (gate is OFF unless this — or config.gate — is set)
//   maxBroken     broken relative links allowed before failing (default 0)
//   maxGaps       total review gaps allowed before failing (default: unlimited)

// Pull every broken link out of the per-section review records into a flat, reportable list.
export function collectBrokenLinks(review) {
  return review.broken.flatMap(s => s.broken.map(ref => ({ section: `${s.repo}/${s.rel}`, ref })));
}

// Decide whether a number-bound is set (config can carry 0, so guard on null/undefined only).
const isSet = (v) => v != null;

export function evaluateGate(review, opts = {}) {
  const minCoverage = isSet(opts.minCoverage) ? Number(opts.minCoverage) : null;
  const maxBroken = isSet(opts.maxBroken) ? Number(opts.maxBroken) : 0;
  const maxGaps = isSet(opts.maxGaps) ? Number(opts.maxGaps) : null;

  const broken = collectBrokenLinks(review);
  const failures = [];

  if (minCoverage != null && review.coverage < minCoverage) {
    failures.push({
      kind: 'coverage',
      message: `coverage ${review.coverage}% is below the required ${minCoverage}%`,
    });
  }
  if (broken.length > maxBroken) {
    failures.push({
      kind: 'broken-links',
      message: `${broken.length} broken link(s) found (max ${maxBroken})`,
      items: broken.map(b => `${b.ref}  (in ${b.section})`),
    });
  }
  if (maxGaps != null && review.gapCount > maxGaps) {
    failures.push({
      kind: 'gaps',
      message: `${review.gapCount} total gaps (max ${maxGaps})`,
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    coverage: review.coverage,
    brokenCount: broken.length,
    gapCount: review.gapCount,
    thresholds: { minCoverage, maxBroken, maxGaps },
  };
}

// Print a CI-readable verdict. Returns the process exit code (0 pass / 1 fail) for the caller.
export function reportGate(result) {
  const t = result.thresholds;
  const bounds = [
    t.minCoverage != null ? `coverage ≥ ${t.minCoverage}%` : null,
    `broken links ≤ ${t.maxBroken}`,
    t.maxGaps != null ? `gaps ≤ ${t.maxGaps}` : null,
  ].filter(Boolean).join(' · ');

  console.log(`\n  Quality gate (${bounds})`);
  console.log(`    coverage ${result.coverage}% · ${result.brokenCount} broken link(s) · ${result.gapCount} gaps`);

  if (result.passed) {
    console.log(`\n  ✓ GATE PASSED — documentation meets the quality bar.\n`);
    return 0;
  }

  console.log(`\n  ✗ GATE FAILED:`);
  for (const f of result.failures) {
    console.log(`    • ${f.message}`);
    for (const item of (f.items || [])) console.log(`        - ${item}`);
  }
  console.log('');
  return 1;
}
