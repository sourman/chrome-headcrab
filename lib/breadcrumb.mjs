import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const BREADCRUMB_DIR =
  process.env.CB_BREADCRUMB_DIR || `${homedir()}/.cache/chad-browser/breadcrumbs`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = randomBytes(2).toString('hex');
  return `bc_${stamp}_${rand}`;
}

function resolvePath(idOrLabel) {
  if (!existsSync(BREADCRUMB_DIR)) return null;
  const files = readdirSync(BREADCRUMB_DIR).filter((f) => f.endsWith('.json'));
  const exact = files.find((f) => f === `${idOrLabel}.json`);
  if (exact) return join(BREADCRUMB_DIR, exact);
  const matches = files
    .map((f) => {
      const full = join(BREADCRUMB_DIR, f);
      let rec;
      try {
        rec = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        return null;
      }
      return typeof rec.label === 'string' && rec.label.includes(idOrLabel) ? { full, rec } : null;
    })
    .filter(Boolean);
  if (matches.length === 0) return null;
  let best = matches[0];
  for (const m of matches) {
    const rec = m.rec;
    const bestStarted = Date.parse(best.rec.startedAt || '');
    const curStarted = Date.parse(rec.startedAt || '');
    if (!Number.isNaN(curStarted) && (Number.isNaN(bestStarted) || curStarted >= bestStarted)) {
      best = m;
    }
  }
  return best.full;
}

export function createBreadcrumb({ cdp, evalInPage }) {
  let recording = null;
  let unsubFrame = null;
  let unsubRequest = null;

  function start({ label }) {
    const id = newId();
    recording = { id, label, startedAt: new Date().toISOString(), events: [], status: 'recording' };

    // Only top-level frames have a null/absent parentId; child frames (iframes,
    // ads) would pollute the trail. CDP fires frameNavigated multiple times per
    // logical navigation (commit, load, same-document navigations) — dedupe
    // consecutive same-URL events so the trail stays clean.
    unsubFrame = cdp.onEvent('Page.frameNavigated', (params) => {
      const frame = params?.frame;
      if (!frame || frame.parentId != null) return;
      const last = recording.events[recording.events.length - 1];
      if (last && last.type === 'navigate' && last.url === frame.url) return;
      recording.events.push({
        type: 'navigate',
        ts: Date.now(),
        url: frame.url,
      });
    });

    // POSTs are meaningful (form submits, mutations); GETs are too noisy to keep.
    // Skip telemetry/analytics endpoints — they flood the trail and hang replay.
    const TELEMETRY_PATTERNS = [
      /\/collect\b/i, /\/analytics/i, /\/track\b/i, /\/beacon/i,
      /google-analytics\.com/i, /googletagmanager\.com/i,
      /collector\./i, /segment\.(io|com)/i, /mixpanel\.com/i,
      /hotjar\.com/i, /sentry\.io/i, /doubleclick\.net/i,
    ];
    unsubRequest = cdp.onEvent('Network.requestWillBeSent', (params) => {
      const req = params?.request;
      if (!req || req.method !== 'POST') return;
      if (TELEMETRY_PATTERNS.some((re) => re.test(req.url))) return;
      const ev = { type: 'request', ts: Date.now(), url: req.url, method: req.method };
      if (req.postData != null) ev.postData = req.postData;
      recording.events.push(ev);
    });

    return { id, label, path: filePathFor(id), recording: { eventCount: 0, status: 'recording' } };
  }

  function filePathFor(id) {
    return join(BREADCRUMB_DIR, `${id}.json`);
  }

  function note(action, detail) {
    if (!recording) throw new Error('breadcrumb: not recording');
    const ev = { type: 'action', ts: Date.now(), action };
    if (detail !== undefined) ev.detail = detail;
    recording.events.push(ev);
    return { recorded: true, index: recording.events.length - 1 };
  }

  function buildRecord() {
    return {
      id: recording.id,
      label: recording.label,
      startedAt: recording.startedAt,
      finishedAt: new Date().toISOString(),
      events: recording.events,
      status: 'stopped',
    };
  }

  async function snapshot() {
    if (!recording) throw new Error('breadcrumb: not recording');
    const record = buildRecord();
    mkdirSync(BREADCRUMB_DIR, { recursive: true });
    const path = filePathFor(record.id);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return {
      id: record.id,
      label: record.label,
      eventCount: record.events.length,
      events: record.events,
      path,
    };
  }

  async function stop() {
    const result = await snapshot();
    if (unsubFrame) {
      unsubFrame();
      unsubFrame = null;
    }
    if (unsubRequest) {
      unsubRequest();
      unsubRequest = null;
    }
    if (recording) recording.status = 'stopped';
    return result;
  }

  async function replay(idOrLabel) {
    const path = resolvePath(idOrLabel);
    if (!path) throw new Error(`breadcrumb: not found: ${idOrLabel}`);
    let record;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`breadcrumb: unreadable: ${path}`);
    }

    const errors = [];
    const manualSteps = [];
    let stepsApplied = 0;
    let stepsSkipped = 0;

    const events = Array.isArray(record.events) ? record.events : [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'navigate' && ev.url) {
        try {
          await cdp.call('Page.navigate', { url: ev.url });
        } catch (e) {
          errors.push({ index: i, type: 'navigate', error: String(e?.message ?? e) });
          stepsSkipped++;
          continue;
        }
        await sleep(400);
        stepsApplied++;
      } else if (ev.type === 'request' && ev.method === 'POST') {
        // Skip telemetry/analytics POSTs — they flood replay and hang on fetch.
        if (TELEMETRY_PATTERNS.some((re) => re.test(ev.url || ''))) {
          stepsSkipped++;
          continue;
        }
        // Best-effort: replay a form POST from page context. Common failure
        // modes (CORS, expired CSRF/auth tokens, same-site cookies) are expected.
        const bodyArg = ev.postData != null ? JSON.stringify(ev.postData) : 'undefined';
        const expr =
          `fetch(${JSON.stringify(ev.url)}, { method: 'POST', ` +
          `body: ${bodyArg}, ` +
          `headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })` +
          `.then((r) => ({ ok: r.ok, status: r.status }))`;
        try {
          await evalInPage(expr);
        } catch (e) {
          errors.push({ index: i, type: 'request', error: String(e?.message ?? e) });
        }
        stepsSkipped++;
      } else if (ev.type === 'action') {
        // Clicks/types need the element present and are not safely auto-replayable.
        manualSteps.push({ index: i, action: ev.action, detail: ev.detail });
        stepsSkipped++;
      } else {
        stepsSkipped++;
      }
    }

    let finalUrl = null;
    try {
      finalUrl = await evalInPage('location.href');
    } catch (e) {
      errors.push({ index: -1, type: 'finalUrl', error: String(e?.message ?? e) });
    }

    return {
      id: record.id,
      stepsApplied,
      stepsSkipped,
      errors,
      finalUrl,
      manualSteps,
    };
  }

  function list() {
    if (!existsSync(BREADCRUMB_DIR)) return [];
    const out = [];
    for (const f of readdirSync(BREADCRUMB_DIR)) {
      if (!f.endsWith('.json')) continue;
      const full = join(BREADCRUMB_DIR, f);
      let rec;
      try {
        rec = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      out.push({
        id: rec.id ?? f.replace(/\.json$/, ''),
        label: rec.label ?? null,
        startedAt: rec.startedAt ?? null,
        finishedAt: rec.finishedAt ?? null,
        eventCount: Array.isArray(rec.events) ? rec.events.length : 0,
        bytes: Buffer.byteLength(JSON.stringify(rec)),
      });
    }
    out.sort((a, b) => {
      const sa = Date.parse(a.startedAt || '');
      const sb = Date.parse(b.startedAt || '');
      if (!Number.isNaN(sa) && !Number.isNaN(sb)) return sb - sa;
      return 0;
    });
    return out;
  }

  function remove(idOrLabel) {
    const path = resolvePath(idOrLabel);
    if (!path) throw new Error(`breadcrumb: not found: ${idOrLabel}`);
    let id;
    try {
      id = JSON.parse(readFileSync(path, 'utf8')).id ?? path;
    } catch {
      id = path;
    }
    rmSync(path, { force: true });
    return { id, removed: true };
  }

  return { start, note, snapshot, stop, replay, list, remove };
}
