// Deep-freeze checkpoints for chad-browser: capture the full restorable state of
// a page (cookies, localStorage, sessionStorage, URL, scroll) to JSON so an
// agent can "save game" before a destructive action and roll back.
//
// Pure ESM, side-effect-free on import. All CDP deps are injected via the
// factory so this module can be wired into the driver without circular imports.

import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export const CHECKPOINT_DIR =
  process.env.CB_CHECKPOINT_DIR || `${homedir()}/.cache/chad-browser/checkpoints`;

function checkpointPath(id) {
  return join(CHECKPOINT_DIR, `${id}.json`);
}

function nowId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `cp_${stamp}_${rand}`;
}

const STORAGE_DUMP_FN = `(() => {
  const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
  return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
})()`;

function ensureDir() {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

export function createCheckpoint({ cdp, evalInPage }) {
  if (!cdp || typeof cdp.call !== 'function') {
    throw new Error('createCheckpoint: expected { cdp } with a .call(method, params) method');
  }
  if (typeof evalInPage !== 'function') {
    throw new Error('createCheckpoint: expected { evalInPage } async function');
  }

  async function save({ label } = {}) {
    const id = nowId();
    const createdAt = new Date().toISOString();

    // Cookies via CDP — the full array from getAllCookies is directly reusable
    // by setCookies on restore.
    let cookies = [];
    try {
      const res = await cdp.call('Network.getAllCookies');
      cookies = Array.isArray(res?.cookies) ? res.cookies : [];
    } catch (e) {
      cookies = [];
    }

    let url = '';
    let title = '';
    let scroll = { x: 0, y: 0 };
    try {
      url = (await evalInPage('location.href')) ?? '';
    } catch {
      url = '';
    }
    try {
      title = (await evalInPage('document.title')) ?? '';
    } catch {
      title = '';
    }
    try {
      const s = await evalInPage('({ x: window.scrollX, y: window.scrollY })');
      scroll = {
        x: Number.isFinite(s?.x) ? s.x : 0,
        y: Number.isFinite(s?.y) ? s.y : 0,
      };
    } catch {
      scroll = { x: 0, y: 0 };
    }

    // Storage via evalInPage (not CDP's Storage domain): CDP Storage needs the
    // exact origin and is finicky with localhost ports; reading from the page
    // is reliable and always targets the active origin.
    let localStorageObj = {};
    let sessionStorageObj = {};
    try {
      const dumps = await evalInPage(STORAGE_DUMP_FN);
      localStorageObj = dumps?.localStorage && typeof dumps.localStorage === 'object' ? dumps.localStorage : {};
      sessionStorageObj =
        dumps?.sessionStorage && typeof dumps.sessionStorage === 'object' ? dumps.sessionStorage : {};
    } catch {
      localStorageObj = {};
      sessionStorageObj = {};
    }

    const record = {
      id,
      label: label ?? null,
      createdAt,
      url,
      title,
      cookies,
      localStorage: localStorageObj,
      sessionStorage: sessionStorageObj,
      scroll,
      version: 1,
    };

    ensureDir();
    const path = checkpointPath(id);
    const json = JSON.stringify(record, null, 2);
    writeFileSync(path, json, 'utf-8');
    const bytes = Buffer.byteLength(json, 'utf-8');

    return {
      id,
      label: record.label,
      path,
      bytes,
      summary: {
        cookies: cookies.length,
        localStorage: Object.keys(localStorageObj).length,
        sessionStorage: Object.keys(sessionStorageObj).length,
        url,
      },
    };
  }

  // Resolve an id-or-label to a parsed record. Exact id match wins; otherwise
  // substring-match labels case-insensitively and pick the newest by createdAt.
  function resolveRecord(idOrLabel) {
    if (!idOrLabel) throw new Error('checkpoint not found: ' + idOrLabel);
    ensureDir();
    const idGuess = idOrLabel.startsWith('cp_') ? idOrLabel : `cp_${String(idOrLabel).replace(/^cp_?/, '')}`;
    const direct = checkpointPath(idGuess);
    if (existsSync(direct)) {
      try {
        const raw = readFileSync(direct, 'utf-8');
        const rec = JSON.parse(raw);
        return { rec, path: direct };
      } catch (e) {
        throw new Error(`checkpoint ${idGuess} is corrupt: ${e.message}`);
      }
    }
    const files = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'));
    const needle = String(idOrLabel).toLowerCase();
    const matches = [];
    for (const f of files) {
      const fp = join(CHECKPOINT_DIR, f);
      let rec;
      try {
        rec = JSON.parse(readFileSync(fp, 'utf-8'));
      } catch {
        continue;
      }
      const labelStr = rec.label == null ? '' : String(rec.label);
      if (
        labelStr.toLowerCase().includes(needle) ||
        String(rec.id ?? '').toLowerCase().includes(needle) ||
        basename(f, '.json').toLowerCase().includes(needle)
      ) {
        matches.push({ rec, path: fp });
      }
    }
    if (matches.length === 0) throw new Error('checkpoint not found: ' + idOrLabel);
    matches.sort((a, b) => String(b.rec.createdAt ?? '').localeCompare(String(a.rec.createdAt ?? '')));
    return matches[0];
  }

  async function restore(idOrLabel) {
    const { rec, path } = resolveRecord(idOrLabel);
    const warnings = [];

    try {
      await cdp.call('Network.setCookies', { cookies: rec.cookies ?? [] });
    } catch (e) {
      warnings.push({ step: 'cookies', error: e.message });
    }

    let navigatedTo = rec.url ?? null;
    try {
      await cdp.call('Page.navigate', { url: rec.url });
      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      warnings.push({ step: 'navigate', error: e.message });
      navigatedTo = null;
    }

    // Restore storage in one IIFE: clear then repopulate. JSON.stringify embeds
    // keys/values safely regardless of quotes/newlines in the data.
    const lsJson = JSON.stringify(rec.localStorage ?? {});
    const ssJson = JSON.stringify(rec.sessionStorage ?? {});
    const restoreExpr = `(() => {
      localStorage.clear(); sessionStorage.clear();
      const ls = ${lsJson};
      for (const k in ls) { try { localStorage.setItem(k, ls[k]); } catch (e) {} }
      const ss = ${ssJson};
      for (const k in ss) { try { sessionStorage.setItem(k, ss[k]); } catch (e) {} }
      return { ls: localStorage.length, ss: sessionStorage.length };
    })()`;
    try {
      await evalInPage(restoreExpr);
    } catch (e) {
      warnings.push({ step: 'storage', error: e.message });
    }

    try {
      const x = Number(rec.scroll?.x) || 0;
      const y = Number(rec.scroll?.y) || 0;
      await evalInPage(`window.scrollTo(${x}, ${y})`);
    } catch (e) {
      warnings.push({ step: 'scroll', error: e.message });
    }

    return {
      id: rec.id,
      found: true,
      applied: {
        cookies: (rec.cookies ?? []).length,
        localStorage: Object.keys(rec.localStorage ?? {}).length,
        sessionStorage: Object.keys(rec.sessionStorage ?? {}).length,
      },
      navigatedTo,
      warnings,
    };
  }

  async function list() {
    ensureDir();
    let files = [];
    try {
      files = readdirSync(CHECKPOINT_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const fp = join(CHECKPOINT_DIR, f);
      let rec;
      try {
        rec = JSON.parse(readFileSync(fp, 'utf-8'));
      } catch {
        continue;
      }
      let bytes = 0;
      try {
        bytes = statSync(fp).size;
      } catch {
        bytes = 0;
      }
      out.push({
        id: rec.id,
        label: rec.label ?? null,
        createdAt: rec.createdAt,
        url: rec.url ?? '',
        title: rec.title ?? '',
        bytes,
      });
    }
    out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return out;
  }

  async function remove(idOrLabel) {
    const { rec, path } = resolveRecord(idOrLabel);
    unlinkSync(path);
    return { id: rec.id, removed: true };
  }

  return { save, restore, list, remove };
}
