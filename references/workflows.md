# chrome-headcrab — workflows

Common recipes. Each assumes Chrome already has remote debugging enabled at
`chrome://inspect/#remote-debugging` and that you have (or will) click **Allow**
once on `attach`.

Single-driver only — no parallel-agent recipes. One attach, drive that session.

## Attach once, drive forever, detach driver only

```bash
chrome-headcrab attach --name live     # click Allow ONCE
chrome-headcrab tabs --name live
chrome-headcrab eval --name live --page 'document.title'

# Multi-step flow → write to a file.
cat > /tmp/flow.js <<'JS'
await waitForReady({ check: 'document.body', hint: 'body' });
return await evalInPage(() => ({
  url: location.href,
  title: document.title,
}));
JS
chrome-headcrab script --name live /tmp/flow.js

chrome-headcrab detach live            # driver only — Chrome stays up
```

**Do not re-attach** between actions. `status` first; if `DRIVER=yes`, keep driving.

## Background / no focus steal (default)

```bash
chrome-headcrab attach --name live --bg    # default; HC_BG=1
# or intentionally raise Chrome:
chrome-headcrab attach --name live --fg
```

Open a tab without yanking the user's window:

```bash
cat <<'JS' | chrome-headcrab eval --name live --stdin
const id = await createPage('https://example.org/');
return { id, backgroundMode, title: await evalInPage('document.title') };
JS
```

Prefer DOM clicks (`evalInPage('…click()')`) over `Input.dispatchMouseEvent` when
you want to stay in the background — synthetic Input can still raise Chrome on
some window managers.

## Switch among the user's existing tabs

```bash
chrome-headcrab tabs --name live
cat <<'JS' | chrome-headcrab eval --name live --stdin
const tabs = await listPageTargets();
const gmail = tabs.find(t => /mail\.google\.com/.test(t.url));
if (!gmail) return { error: 'gmail not open', tabs: tabs.map(t => t.url) };
await use(gmail.targetId);   // attach only — does NOT activate/raise in bg mode
return await evalInPage(() => ({ url: location.href, title: document.title }));
JS
```

## Read a hydrated SPA fact

```bash
cat <<'JS' | chrome-headcrab eval --name live --page --wait 'document.querySelector("table tbody tr")' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return { count: rows.length, first: rows[0]?.textContent.trim() };
JS
```

## Point a browser tool at Chrome (HTTP discovery)

Raw `:9222` `/json` often 404s under the Allow flow. After attach:

```bash
HTTP=$(chrome-headcrab http --name live)   # e.g. http://127.0.0.1:9224
curl -s "$HTTP/json/list" | head
# Puppeteer/Playwright connectOverCDP("$HTTP") — but prefer the held driver
# so you don't open a second WS (re-Allow).
```

## Teardown hygiene

```bash
chrome-headcrab status            # what's attached + driver alive?
chrome-headcrab detach <name>     # drop driver + our shim; NEVER kills Chrome
chrome-headcrab gc                # reap dead runfiles / orphan sockets
```

`detach` never quits Google Chrome — it only drops the driver (and our shim).
