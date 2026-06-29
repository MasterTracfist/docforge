// INIT — interactive wizard that onboards ANY technical project: detect repos + frameworks,
// ask for hosted addresses + auth, and write a ready-to-run doc.config.json. Zero deps.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const BASE_CONFIG = {
  ignore: ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', 'target', 'vendor', '.cache'],
  include: {
    markdown: ['.md', '.markdown'],
    images: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'],
    other: ['.docx', '.pptx', '.pdf', '.yaml', '.yml', '.json'],
  },
  documents: [
    { id: 'user-guide', title: 'User Guide', audience: 'End users & operators', blurb: 'How to use the product day to day.', match: ['quickstart', 'getting.?started', '_guide', 'user', 'onboard', 'console', 'dashboard', 'tutorial', 'how.?to'] },
    { id: 'technical-manual', title: 'Technical Manual', audience: 'Developers', blurb: 'Internal architecture, data model, and service behaviour.', match: ['database', 'schema', 'websocket', 'protocol', 'microservice', 'architecture', 'data', 'caching', 'queue', 'graphql', 'design'] },
    { id: 'api-reference', title: 'API Reference', audience: 'Integrators', blurb: 'Endpoints, payloads, and integration surfaces.', match: ['api', 'integration', 'endpoint', 'swagger', 'openapi', 'rest', 'webhook', 'graphql'] },
    { id: 'operations', title: 'Operations Runbook', audience: 'SRE & platform admins', blurb: 'Deploy, monitor, secure, and recover the system.', match: ['deploy', 'monitor', 'security', 'performance', 'runbook', 'backup', 'k8s', 'kubernetes', 'ops', 'scaling', 'infra'] },
  ],
  fallbackDocument: 'technical-manual',
  sectionOrder: ['overview', 'how-to', 'reference', 'concept', 'ops', 'troubleshooting', 'other'],
};

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }

// Is this directory a project root worth including?
function looksLikeProject(dir) {
  return ['package.json', 'pom.xml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'pyproject.toml',
    'build.gradle', 'CMakeLists.txt', 'composer.json', '.git'].some(f => exists(path.join(dir, f)));
}

// Fingerprint a repo: language/framework + whether it's a frontend we could screenshot.
function detect(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  const out = { framework: 'unknown', frontend: false, spa: false, router: null };
  if (exists(path.join(dir, 'pom.xml'))) { out.framework = 'Java / Spring'; return out; }
  if (exists(path.join(dir, 'go.mod'))) { out.framework = 'Go'; return out; }
  if (exists(path.join(dir, 'Cargo.toml'))) { out.framework = 'Rust'; return out; }
  if (exists(path.join(dir, 'CMakeLists.txt')) || exists(path.join(dir, 'prj.conf'))) { out.framework = 'C / embedded'; return out; }
  if (pkg) {
    const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (d.next) { out.framework = 'Next.js'; out.frontend = true; out.spa = false; out.router = 'next'; }
    else if (d.react) { out.framework = 'React'; out.frontend = true; out.spa = true; out.router = 'react-router'; }
    else if (d.vue) { out.framework = 'Vue'; out.frontend = true; out.spa = true; out.router = 'vue-router'; }
    else if (d.svelte) { out.framework = 'Svelte'; out.frontend = true; out.spa = true; }
    else if (d.express || d['@nestjs/core']) { out.framework = d['@nestjs/core'] ? 'NestJS' : 'Express'; }
    else { out.framework = 'Node.js'; }
  }
  return out;
}

export async function runWizard(defaultConfigPath) {
  // Interactive over a TTY; deterministic over a pipe. For piped input we read the whole stream
  // up front and serve a queue (avoids readline EOF races), falling back to defaults when it runs out.
  const isTTY = Boolean(stdin.isTTY);
  const rl = isTTY ? readline.createInterface({ input: stdin, output: stdout }) : null;
  let queue = [];
  if (!isTTY) { try { queue = fs.readFileSync(0, 'utf8').split('\n'); } catch { queue = []; } }
  const readLine = async (prompt) => {
    if (isTTY) return (await rl.question(prompt)).trim();
    stdout.write(prompt);
    const line = queue.length ? queue.shift() : '';
    stdout.write(line + '\n');
    return line.trim();
  };
  const ask = async (q, def) => (await readLine(def ? `${q} [${def}]: ` : `${q}: `)) || def || '';
  const askYN = async (q, def = true) => {
    const a = (await readLine(`${q} (${def ? 'Y/n' : 'y/N'}): `)).toLowerCase();
    return a ? a.startsWith('y') : def;
  };

  console.log('\n┌─ Doc setup ─────────────────────────────────────────────┐');
  console.log('│ Point me at a project and answer a few questions; I write the │');
  console.log('│ config and can build the manual + capture live screens.       │');
  console.log('└───────────────────────────────────────────────────────────────┘\n');

  // 1) Where the projects live
  const baseDir = path.resolve(await ask('Base directory to scan for repos', process.cwd()));
  if (!exists(baseDir)) { console.log(`  ! ${baseDir} does not exist.`); rl.close(); return; }

  // 2) Detect candidate repos
  const candidates = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(baseDir, e.name))
    .filter(looksLikeProject)
    .map(dir => ({ dir, ...detect(dir) }));
  if (!candidates.length) { console.log(`  ! no project-looking dirs under ${baseDir}.`); rl.close(); return; }

  console.log(`\n  Found ${candidates.length} candidate repos:`);
  candidates.forEach((c, i) => console.log(`   ${String(i + 1).padStart(2)}. ${path.basename(c.dir)}  —  ${c.framework}${c.frontend ? ' (frontend)' : ''}`));
  const pick = await ask('\n  Include which? (comma numbers, or "all")', 'all');
  const chosen = pick.toLowerCase() === 'all'
    ? candidates
    : pick.split(',').map(n => candidates[Number(n.trim()) - 1]).filter(Boolean);

  // 3) Project meta + output
  const title = await ask('\nProject / manual title', path.basename(baseDir).replace(/[-_]/g, ' ').replace(/^\w/, c => c.toUpperCase()));
  const subtitle = await ask('Subtitle', 'User Guide & Technical Reference');
  const output = path.resolve(await ask('Output directory for the built manual', path.join(baseDir, `${title.replace(/\s+/g, '-')}-Manual`)));

  // 4) Live screen capture
  const targets = [];
  if (await askYN('\nCapture live UI screenshots from hosted apps?', true)) {
    const frontends = chosen.filter(c => c.frontend);
    for (const c of frontends) {
      const name = path.basename(c.dir);
      const url = await ask(`  Hosted URL for "${name}" (blank to skip)`, '');
      if (!url) continue;
      const t = { name: `${name} (${url.replace(/^https?:\/\//, '')})`, baseUrl: url.replace(/\/$/, ''), sourceRepo: c.dir, spa: c.spa };
      if (await askYN(`  Does "${name}" require login?`, true)) {
        const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        const userEnv = await ask('    Env var holding the USERNAME/email', `${slug}_USER`);
        const passEnv = await ask('    Env var holding the PASSWORD', `${slug}_PASS`);
        const mfa = await askYN('    MFA / TOTP enabled?', false);
        t.auth = {
          loginUrl: await ask('    Login path', '/'),
          userSelector: await ask('    Username field CSS selector', 'input[type=email],input[name=username]'),
          passSelector: 'input[type=password]',
          userEnv, passEnv, successWaitMs: 3500,
          ...(mfa ? { totpEnv: `${slug}_TOTP`, totpSelector: 'input[placeholder*=digit],input[name=otp],input[name=code]' } : {}),
        };
      }
      t.routes = [{ path: '/', label: 'Home' }];
      targets.push(t);
    }
    if (await askYN('  Add an API docs / Swagger URL target?', false)) {
      const url = await ask('  API base URL', '');
      if (url) targets.push({ name: `API (${url.replace(/^https?:\/\//, '')})`, baseUrl: url.replace(/\/$/, ''), routes: [{ path: '/', label: 'API root' }, { path: '/api-docs', label: 'Swagger docs' }] });
    }
  }

  // 5) Assemble + write config
  const config = {
    title, subtitle, output,
    roots: chosen.map(c => c.dir),
    ...BASE_CONFIG,
    ...(targets.length ? { screens: { viewport: { width: 1440, height: 900 }, devtoolsPort: 9333, targets } } : {}),
  };
  const cfgPath = defaultConfigPath;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  if (exists(cfgPath)) {
    const bak = cfgPath + '.bak';
    fs.copyFileSync(cfgPath, bak);
    console.log(`\n  (backed up existing config → ${path.basename(bak)})`);
  }
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  console.log(`\n  ✓ Wrote ${cfgPath}`);
  console.log(`     ${chosen.length} repos · ${config.documents.length} target docs · ${targets.length} screen target(s)`);

  // 6) Offer to run
  const buildNow = await askYN('\nBuild the manual now?', true);
  const captureNow = targets.length ? await askYN('Capture live screens now? (needs the apps reachable + creds exported)', false) : false;
  if (rl) rl.close();
  return { config, cfgPath, buildNow, captureNow };
}
