// CAPTURE — drive system Chrome headlessly over the DevTools Protocol to screenshot running apps.
// Zero npm deps: uses Node's built-in fetch + WebSocket to speak CDP. Gated behind app reachability.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { discoverRoutes } from './routes.js';

const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// RFC-6238 TOTP from a base32 secret — lets MFA targets log in without a human.
// The secret only ever comes from an env var the user sets; never from chat/config/code.
function totp(base32, step = 30, digits = 6) {
  const clean = base32.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of clean) { const v = alpha.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const bytes = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / step)));
  const hmac = crypto.createHmac('sha1', bytes).update(counter).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac.readUInt32BE(off) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
  return code;
}

function tcpOpen(host, port, timeout = 1200) {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); res(v); } };
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    setTimeout(() => fin(false), timeout);
  });
}

function parseHostPort(url) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
}

async function launchChrome(port) {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-chrome-'));
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${userDir}`, 'about:blank'];
  const proc = spawn(CHROME, args, { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { if (await tcpOpen('127.0.0.1', port)) break; await sleep(200); }
  return { proc, userDir };
}

async function pageWsUrl(port) {
  for (let i = 0; i < 25; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools page target never appeared');
}

// Minimal CDP client over the built-in WebSocket.
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.waiters = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('CDP websocket error'));
      this.ws.onmessage = (ev) => this._msg(ev.data);
    });
  }
  _msg(data) {
    const m = JSON.parse(data);
    if (m.id && this.pending.has(m.id)) {
      const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method) {
      this.waiters = this.waiters.filter((w) => { if (w.method === m.method) { w.res(m.params); return false; } return true; });
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  wait(method, timeout = 12000) {
    return new Promise((res) => { const w = { method, res }; this.waiters.push(w); setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); res(null); }, timeout); });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Log a target in using credentials read from env vars (set by the user; never seen by Claude).
// Returns 'ok' | 'skipped' | 'missing-creds' | 'failed:<reason>'.
async function login(cdp, t, vp) {
  const a = t.auth;
  if (!a) return 'skipped';
  const user = a.userEnv ? process.env[a.userEnv] : undefined;
  const pass = a.passEnv ? process.env[a.passEnv] : undefined;
  const code = a.totpEnv && process.env[a.totpEnv] ? totp(process.env[a.totpEnv]) : undefined;
  if (!user || !pass) return 'missing-creds';

  const loginUrl = /^https?:/.test(a.loginUrl || '')
    ? a.loginUrl
    : t.baseUrl.replace(/\/$/, '') + (a.loginUrl || '/login');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale || 1, mobile: false });
  const loaded = cdp.wait('Page.loadEventFired', 12000);
  await cdp.send('Page.navigate', { url: loginUrl });
  await loaded;
  await sleep(a.formWaitMs ?? 1200);

  // Fill + submit entirely inside the page. Uses the native value setter so React/Vue
  // controlled inputs register the change. Credentials are passed as JSON literals.
  const fn = `(() => {
    const set = (sel, val) => {
      if (!sel || val == null) return true;
      const el = document.querySelector(sel);
      if (!el) return false;
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      (d && d.set ? d.set : (v)=>{el.value=v;}).call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const okU = set(${JSON.stringify(a.userSelector || 'input[type=email],input[name=username],#username,#email')}, ${JSON.stringify(user)});
    const okP = set(${JSON.stringify(a.passSelector || 'input[type=password]')}, ${JSON.stringify(pass)});
    ${code ? `set(${JSON.stringify(a.totpSelector || 'input[name=otp],input[name=code],input[autocomplete=one-time-code]')}, ${JSON.stringify(code)});` : ''}
    let btn = ${a.submitSelector ? `document.querySelector(${JSON.stringify(a.submitSelector)})` : 'null'};
    if (!btn) btn = [...document.querySelectorAll('button,input[type=submit]')].find(b => /log\\s?in|sign\\s?in|continue/i.test(b.textContent || b.value || ''));
    if (btn) { btn.click(); return { ok: okU && okP, submitted: true }; }
    const form = document.querySelector('form'); if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return { ok: okU && okP, submitted: true }; }
    return { ok: okU && okP, submitted: false };
  })()`;
  let res;
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: fn, returnByValue: true });
    res = r.result?.value;
  } catch (e) { return `failed:${e.message}`; }
  if (!res?.ok) return 'failed:form-fields-not-found';
  if (!res.submitted) return 'failed:no-submit-control';
  await sleep(a.successWaitMs ?? 3000); // let the post-login navigation + first data load settle

  // Verify the login actually took. If a password field is still on the page after submitting,
  // the credentials were rejected — report it rather than falsely claiming "signed in".
  try {
    const chk = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({ pw: !!document.querySelector('input[type=password]') }))()`,
      returnByValue: true,
    });
    if (chk.result?.value?.pw) return 'failed:credentials-rejected';
  } catch { /* if the check itself fails, fall through and assume ok */ }
  return 'ok';
}

async function setViewport(cdp, vp) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.scale || 1, mobile: false });
}

// Full HTTP navigation (fresh GET) — right for server-rendered pages / public URLs / Swagger.
async function gotoFull(cdp, url, waitMs) {
  const loaded = cdp.wait('Page.loadEventFired', 12000);
  await cdp.send('Page.navigate', { url });
  await loaded;
  await sleep(waitMs ?? 1400);
}

// Client-side SPA navigation: push the path into the History API and nudge the router.
// Avoids a fresh GET, so single-page apps (and their nginx) don't 403 on deep links.
async function gotoSpa(cdp, urlPath, waitMs) {
  const expr = `(() => { try {
    history.pushState({}, '', ${JSON.stringify(urlPath)});
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new Event('locationchange'));
    return location.pathname;
  } catch (e) { return 'ERR:' + e.message; } })()`;
  await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  await sleep(waitMs ?? 1600); // let the route's components mount + data load
}

async function capture(cdp, vp) {
  const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
  const width = Math.ceil(cssContentSize?.width || vp.width);
  const height = Math.min(Math.ceil(cssContentSize?.height || vp.height), 20000);
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return { buffer: Buffer.from(data, 'base64'), width, height };
}

/**
 * Capture product screens. `opts.url`/`opts.name` capture a single ad-hoc URL;
 * otherwise iterate cfg.screens.targets, skipping any whose server is unreachable.
 */
export async function captureScreens(cfg, opts = {}) {
  const sc = cfg.screens || {};
  const vp = { width: 1440, height: 900, scale: 1, ...(sc.viewport || {}) };
  let targets;
  if (opts.url) {
    targets = [{ name: opts.name || 'page', baseUrl: opts.url, routes: [{ path: '', label: opts.label || 'Page' }] }];
  } else {
    targets = sc.targets || [];
  }
  if (!targets.length) { console.log('  (no screen targets configured; set screens.targets in doc.config.json)'); return []; }

  const outImgDir = path.join(cfg.output, 'assets', 'screens');
  fs.mkdirSync(outImgDir, { recursive: true });

  // --target=<substr>: capture only matching targets (case-insensitive, name match).
  if (opts.target) {
    const q = opts.target.toLowerCase();
    const before = targets.length;
    targets = targets.filter(t => t.name.toLowerCase().includes(q));
    if (!targets.length) { console.log(`  no target matches --target="${opts.target}" (of ${before})`); return []; }
    console.log(`  filtered to ${targets.length}/${before} target(s) matching "${opts.target}"`);
  }

  // Expand routes from the frontend source where a target declares a sourceRepo.
  for (const t of targets) {
    if (t.sourceRepo && fs.existsSync(t.sourceRepo)) {
      const found = discoverRoutes(t.sourceRepo, { exclude: t.excludeRoutes, max: t.maxRoutes });
      const explicit = t.routes || [];
      const paths = new Set(explicit.map(r => r.path));
      t.routes = [...explicit, ...found.filter(r => !paths.has(r.path))];
      console.log(`  • ${t.name}: discovered ${found.length} routes from ${path.basename(t.sourceRepo)} (${t.routes.length} total)`);
    }
  }

  // --route=<substr>: within each target, keep only routes whose path or label matches.
  if (opts.route) {
    const q = opts.route.toLowerCase();
    for (const t of targets) {
      t.routes = (t.routes || []).filter(r => (r.path || '').toLowerCase().includes(q) || (r.label || '').toLowerCase().includes(q));
    }
    targets = targets.filter(t => (t.routes || []).length);
    if (!targets.length) { console.log(`  no route matches --route="${opts.route}"`); return []; }
    console.log(`  filtered to routes matching "${opts.route}"`);
  }

  // Filter to reachable targets so the build never hard-fails on a stopped app.
  const live = [];
  for (const t of targets) {
    const { host, port } = parseHostPort(t.baseUrl);
    if (await tcpOpen(host, port)) live.push(t);
    else console.log(`  - skip ${t.name} (${t.baseUrl} not reachable)`);
  }
  if (!live.length) { console.log('  no reachable app targets — start a dev server then re-run capture.'); return []; }

  const port = sc.devtoolsPort || 9333;
  const { proc, userDir } = await launchChrome(port);
  const manifest = [];
  try {
    const cdp = new CDP(await pageWsUrl(port));
    await cdp.open();
    await cdp.send('Page.enable');
    await setViewport(cdp, vp);
    const slugify = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    for (const t of live) {
      let authed = false, loginStatus = null;
      if (t.auth) {
        loginStatus = await login(cdp, t, vp);
        authed = loginStatus === 'ok';
        if (loginStatus === 'ok') console.log(`  ⤷ ${t.name}: signed in (verified)`);
        else if (loginStatus === 'missing-creds') console.log(`  ⤷ ${t.name}: auth configured but ${[t.auth.userEnv, t.auth.passEnv].filter(Boolean).join('/')} not set — capturing public pages only`);
        else if (loginStatus === 'failed:credentials-rejected') console.log(`  ✗ ${t.name}: login REJECTED — wrong ${t.auth.userEnv}/${t.auth.passEnv}? (still on a login page after submit) — capturing public pages only`);
        else if (loginStatus !== 'skipped') console.log(`  ⤷ ${t.name}: login ${loginStatus} — capturing public pages only`);
      }
      // SPA targets: boot the app once at "/", then route client-side (no per-page GET → no nginx 403).
      if (t.spa && !authed) await gotoFull(cdp, t.baseUrl.replace(/\/$/, '') + '/', 1600);

      const seen = new Map(); // image hash -> slug, to collapse identical renders (e.g. login redirects)
      let gated = 0;
      for (const r of (t.routes || [{ path: '', label: 'Home' }])) {
        const url = t.baseUrl.replace(/\/$/, '') + (r.path || '');
        const slug = `${slugify(t.name)}-${slugify(r.label || r.path || 'home')}`;
        const file = path.join(outImgDir, `${slug}.png`);
        try {
          if (t.spa) await gotoSpa(cdp, r.path || '/', r.waitMs);
          else await gotoFull(cdp, url, r.waitMs);
          const { buffer, width, height } = await capture(cdp, vp);
          const hash = crypto.createHash('sha1').update(buffer).digest('hex');
          if (seen.has(hash)) { gated++; continue; } // duplicate of an already-captured page (login/redirect/403)
          seen.set(hash, slug);
          fs.writeFileSync(file, buffer);
          manifest.push({ name: t.name, label: r.label || r.path || 'Home', url, file: `assets/screens/${slug}.png`, width, height });
          console.log(`  ✓ ${t.name} ${r.label || r.path}  (${width}×${height})`);
        } catch (e) {
          console.log(`  ! failed ${url}: ${e.message}`);
        }
      }
      if (gated > 0) {
        const why = loginStatus === 'failed:credentials-rejected'
          ? `the login was rejected — check the password in ${t.auth.passEnv}`
          : (t.auth && loginStatus !== 'ok')
            ? `set ${[t.auth.userEnv, t.auth.passEnv].filter(Boolean).join('/')}`
            : 'these pages need authentication';
        console.log(`  ⓘ ${t.name}: ${gated} route(s) collapsed to an already-captured page (login/redirect) — ${why}.`);
      }
    }
    cdp.close();
  } finally {
    proc.kill();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Full run overwrites; a filtered run (--target/--route/--url) merges so other screens survive.
  let out = manifest;
  if (opts.target || opts.route || opts.url) {
    let prev = [];
    try { prev = JSON.parse(fs.readFileSync(path.join(cfg.output, 'screens.json'), 'utf8')); } catch { /* none */ }
    const fresh = new Set(manifest.map(m => m.file));
    out = [...prev.filter(p => !fresh.has(p.file)), ...manifest];
  }
  fs.writeFileSync(path.join(cfg.output, 'screens.json'), JSON.stringify(out, null, 2));
  return manifest;
}
