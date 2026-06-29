# Doc

Point it at **any technical project** and it builds review-ready documentation: it crawls the repos
for Markdown, classifies it by audience, **generates** architecture/data-model/pipeline diagrams from
the code, **captures** live UI screenshots of the running product, and **scores documentation
coverage** for the review phase — then renders a complete **User Guide**, **Technical Manual**,
**API Reference**, **Operations Runbook**, **System Architecture**, **Product Screens**, and a
**Review Dashboard** as a self-contained static site.

## Review Dashboard

Every build produces a coverage report ([review.js](src/review.js)) aimed at the review phase:

- A headline **coverage score** + per-document bars (complete / thin / stub).
- Inline **status badges** on every section (`complete · 416w`, `thin · 215w`, `stub`).
- A **gap checklist** reviewers can tick (state saved in `localStorage`), covering: thin/stub
  sections, **broken relative links**, **data-model entities with no prose**, captured screens with
  no written page, and repositories with no documentation.

Thresholds: a section is `stub` under 60 words, `thin` under 220, else `complete`. The CLI prints a
one-line summary (`review: 93% coverage · 34 gaps …`) on every build.

## Quality gate (CI)

The same coverage analysis can fail the build, so the manual can be guarded in CI like lint/test.
Pass a coverage floor (and optionally a broken-link / gap budget) and `build` exits **non-zero** when
the bar isn't met:

```bash
node src/index.js build --min-coverage=85                 # fail if coverage < 85%
node src/index.js build --min-coverage=85 --max-broken=0  # …and fail on any broken link (default)
node src/index.js build --min-coverage=85 --max-gaps=40   # …and cap total review gaps
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--min-coverage=N` | Section coverage % floor. Also **activates** the gate. | off |
| `--max-broken=N` | Broken relative links allowed before failing. | `0` |
| `--max-gaps=N` | Total review gaps allowed before failing. | unlimited |

The gate is off for a plain `build` unless one of these flags is set (or a `gate` block is present in
config). It prints a `GATE PASSED` / `GATE FAILED` verdict listing every offending threshold and each
broken link with its source file, then exits `0` (pass) or `1` (fail). Defaults can live in
`doc.config.json` and are overridden by CLI flags:

```json
"gate": { "minCoverage": 85, "maxBroken": 0, "maxGaps": 40 }
```

### Enforcing it

**Self-test** — Doc gates its own bundled sample corpus on every push via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml):

```bash
npm test            # build examples/ and fail if coverage < 70% or any broken link
npm run demo        # just build the sample manual (no gate)
```

**Local git pre-push hook** — block a push when your docs regress, no GitHub needed. Install the
[`ci/pre-push`](ci/pre-push) hook into any repo and point it at your config:

```bash
sh ci/install-hook.sh /path/to/your/repo
```

Each push from a hooked repo rebuilds the manual and aborts on failure; bypass once with
`git push --no-verify`. Configure via `DOC_DIR`, `DOC_CONFIG`, `DOC_MIN_COVERAGE`,
and `DOC_MAX_BROKEN` (see [`ci/pre-push`](ci/pre-push)).

**GitHub Actions in your project** — run the gate in the repo(s) you document. Check the corpus out,
then run Doc (e.g. `npx github:<org>/doc build --config=<your-config> --min-coverage=85`).
For a multi-repo manual the pattern is: one
`actions/checkout` per documented repo into `corpus/<name>`, a config with relative `corpus/*` roots,
then the gated build. A missing root is skipped with a warning, so partial corpora still gate.

## Quick start — the wizard

```bash
node src/index.js init      # interactive setup: pick repos, hosted URLs, logins → writes config
node src/index.js serve     # preview the built manual at http://localhost:4800
```

`init` scans a base directory, auto-detects each repo's framework (React / Next / Vue / Spring / Go /
Rust / C / Node…), asks which to include, asks for hosted addresses + whether pages need login (and
which **env vars** hold the credentials — never the secrets themselves), then writes a ready-to-run
`doc.config.json` and offers to build + capture. Existing configs are backed up to `.bak`.

## Manual commands

```bash
node src/index.js build                    # discover → classify → assemble → generate → render
node src/index.js build --min-coverage=85  # …and fail (exit 1) if the quality gate isn't met
node src/index.js capture                  # screenshot the hosted apps (see Image generation)
node src/index.js serve --port=4800        # build (if needed) + serve the site
```

Output goes to the `output` path in `doc.config.json`.

## Pipeline

`DISCOVER → CLASSIFY → ASSEMBLE → GENERATE → RENDER`

1. **discover** (`src/discover.js`) — walk `roots`, honor `ignore`, manifest every `.md`, image, and other file.
2. **classify** (`src/classify.js`) — heuristic title/summary/doc-type extraction; score each doc into a target document via `documents[].match` patterns.
3. **assemble** (`src/assemble.js`) — bin sections per document, order them (overview → how-to → reference → ops → troubleshooting), resolve referenced images, collect orphan screenshots, detect gaps.
4. **generate** (`src/generate.js`) — **crawl the product + tech stack and synthesize diagrams as SVG images**:
   - `stackscan.js` fingerprints each repo (language/framework/runtime) and the infra it implies (deps + docker-compose).
   - `entities.js` parses TypeORM `*.entity.ts` classes into an ER model (relations + inferred FK edges).
   - `diagrams.js` renders three SVGs — **system architecture**, **telemetry pipeline**, **data model** — written to `assets/diagrams/*.svg` (downloadable) and inlined into a generated **System Architecture** page with a tech-stack matrix.
5. **render** (`src/render.js`) — emit one HTML page per document + Overview home + System Architecture + Screens & Media gallery, copy image assets, rewrite image links.

## Configuration

Everything lives in `doc.config.json`: `roots`, `ignore`, `documents` (id/title/audience/match
keywords), `fallbackDocument`, and `sectionOrder`. Add a document by adding an entry to `documents`
with `match` keywords; re-run `build`.

## Image generation

Doc **creates** images, not just harvests them — from two independent sources:

1. **Generated diagrams** (always, in the default `build`): architecture, telemetry pipeline, and
   data model, synthesized from the code/stack (see GENERATE above).
2. **Live UI screenshots** (`capture` command): drives **system Chrome headlessly over the DevTools
   Protocol** — zero npm deps — to screenshot the running product, then folds the shots into a
   **Product Screens** page on the next `build`.

```bash
# capture every reachable target in config.screens.targets (unreachable ones are skipped)
node src/index.js capture
# just one app (substring match on target name)
node src/index.js capture --target=app
# just one page across targets (substring match on route path/label)
node src/index.js capture --target=app --route=devices
# or one ad-hoc URL
node src/index.js capture --url=https://app.example.com --name="My App"
node src/index.js build      # folds screens.json into the Product Screens page
```

A full `capture` overwrites `screens.json`; a **filtered** run (`--target`/`--route`/`--url`)
**merges** — it refreshes only the matched screens and leaves the rest of the manifest intact, so
you can re-shoot one page without re-running the whole ~50-page sweep.

Targets live under `screens.targets` in the config and point at your **deployed apps**
(e.g. `app.example.com`, `admin.example.com`, `api.example.com`). Each target has routes
(`{ path, label, waitMs }`); full-page PNGs land in `assets/screens/` with a `screens.json`
manifest. Capture is a separate command (not part of `build`) because it depends on the apps
being reachable. Override the browser with `CHROME_BIN`.

### Authenticated capture (screens behind the sign-in wall)

Add an `auth` block to a target to capture dashboards, not just login pages. **Credentials are
read from environment variables you set — they never appear in chat, the config, the code, or
Claude's context.** The tool fills the live login form, submits, waits, then captures the
protected routes in the same session.

```bash
export APP_USER='you@example.com'          # names referenced by the target's auth block
export APP_PASS='…'
export ADMIN_USER='…'
export ADMIN_PASS='…'
export ADMIN_TOTP='<base32-MFA-secret>'    # optional; RFC-6238 code is generated for you
node src/index.js capture && node src/index.js build
```

The `auth` block holds only selectors + the **env-var names** (`userEnv`/`passEnv`/`totpEnv`) and
optional `loginUrl`/`submitSelector`/`successWaitMs` — never the secrets themselves. If the env
vars aren't set, that target silently falls back to public-page capture.

### Route auto-discovery + SPA navigation

Rather than hand-list pages, give a target a `sourceRepo` and Doc reads its React Router
definitions ([routes.js](src/routes.js)) and captures **every** page (skipping `:param` routes,
wildcards, and auth/utility paths; `excludeRoutes`/`maxRoutes` to trim). A typical SPA expands to a
few dozen routes this way.

Because the frontends are **client-routed SPAs**, hitting a deep URL like `/devices` directly would
return an nginx **403** (the server only serves the app at `/`). So targets marked `"spa": true`
are captured correctly: load `/` once (authenticated), then navigate **client-side** via the
History API for each route — no fresh GET, no 403. Identical renders (e.g. every protected route
bouncing to the login page when not signed in) are de-duplicated by image hash and reported as
"collapsed", so you don't get 40 copies of the login screen.

## Roadmap

- **ENRICH (LLM pass)** — Claude classification for ambiguous files, auto-captions for images,
  cross-repo link rewriting, gap prose ("feature has code + screens but no docs").
- **More generated diagrams** — sequence flows, deployment/k8s topology, per-service request maps.
- **PDF / DOCX export** — render the same intermediate to a bound manual.
- **Editable `outline.yaml`** — generated plan you tweak before final render.
