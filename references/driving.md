# chrome-headcrab — driving the page

> **chrome-headcrab note:** The browser is already running — you attach once
> (`chrome-headcrab attach`), then drive. Background / no-focus mode is **ON by
> default** (`HC_BG=1` / `--bg`). Prefer `createPage(url)` / `use(targetId)` /
> `evalInPage` over `Input.dispatch*` and never call `activateTarget` /
> `bringToFront` unless the user wants Chrome raised.
>
> This skill is **single-session only**. One Google Chrome, one held driver —
> no multi-agent parallelization or isolated browser clones.

The `eval` subcommand runs JS in one of two contexts:

- **`--page`** — the JS runs in the page. `document.querySelector(...)` works directly.
  The body is auto-wrapped in `evalInPage(() => { ... })()` with IIFE detection —
  a bare expression returns its value; multi-statement bodies use `return`.
- **default (Node)** — the JS runs in the driver's Node process with the full CDP
  helper surface below in scope. The body is wrapped in an async function, so use
  `await` freely and **`return` the result**.

Both modes accept `--stdin` (pipe a heredoc) and `--file <path>` as alternatives to
the inline positional `<js>` arg — use `--stdin` for anything with nested quotes.

## What's in scope

| Name | What it does |
|---|---|
| `session.<Domain>.<Method>(params)` | Full raw CDP surface. `session.Page.navigate(...)`, `session.Runtime.evaluate(...)`, `session.Input.insertText(...)`, etc. Domain/method names map 1:1 to CDP. |
| `evalInPage(jsExprOrFn)` | `Runtime.evaluate` with `returnByValue:true, awaitPromise:true`. Accepts **either** a string expression **or** an arrow function (preferred — no quoting hell). Returns the value directly. The expression runs in the page's JS context. |
| `navigate(url, { timeout?, hint? })` | `Page.navigate` + wait for `readyState === 'complete'`. Preferred over the raw two-step — eliminates the #1 wrong-answer source (reading mid-hydration after a nav). |
| `waitForNavigation({ timeout?, hint? }, trigger)` | Arm a `Page.frameNavigated` listener, run `trigger` (e.g. a form submit or button click that causes a server-side navigation), then wait for the destination to settle. Returns the destination URL. Solves the read-after-submit pattern. |
| `typeInto(selector, text, { delay? })` | Focus a field, select-all, delete, then `Input.insertText`. **Replaces** the value (unlike raw `insertText`, which appends). Works on React-controlled inputs. Throws clearly on readonly/disabled/hidden/contenteditable. Returns the field's new value. |
| `resetInterception()` | Disable `Fetch`/`Network.setRequestInterception`. Call after traffic-interception experiments (blocking/mocking) so the loader doesn't stay wedged. Safe when no interception is active. |
| `waitForReady({ check, timeout?, hint? })` | The **universal wait/poll** primitive. Polls ANY JS expression (in the page) until it returns truthy — use it for content-waiting (`document.body.innerText.includes("Done")`), element-waiting (`document.querySelector('#results')`), or readiness (`document.readyState === 'complete'`). Default timeout 10s, interval 300ms. `hint` is a human label included in the timeout error. If `check` itself throws, the error is surfaced immediately. On timeout, the error includes page diagnostics (body text length + last 300 chars, the check, elapsed time) so you can reason in one read. If `timeout` exceeds the eval body timeout, the body timeout is auto-extended. |
| `waitForDomStable({ timeout?, hint?, minStableMs? })` | Wait until `querySelectorAll('*').length` is unchanged across **3** consecutive polls AND no skeleton/spinner selectors present AND the stable window spans ≥ `minStableMs` (default 600ms). **Weak heuristic** — prefer `waitForReady({check})` against real content for production scraping. |
| `listPageTargets()` | Page targets from `Target.getTargets` (excludes chrome:// and devtools://). |
| `use(targetId)` | Switch the active target via `Target.attachToTarget`. For cross-origin iframes and multi-tab flows. In bg mode this does **not** raise Chrome. |
| `createPage(url, { foreground? })` | Create a tab. Default respects **background mode** (`HC_BG=1`): `Target.createTarget({ background: true })` so Chrome stays headed but does not steal OS focus. Pass `{ foreground: true }` only when you want attention. |
| `activateTarget(targetId?)` | Explicitly foreground a tab (`Target.activateTarget`). Opt-in; not called automatically in bg mode. |
| `bringToFront()` | `Page.bringToFront` on the active page. Opt-in focus steal. |
| `backgroundMode` | Boolean reflecting `HC_BG` for the live driver. |
| `onEvent(method, fn)` | Subscribe to a CDP event. Returns an unsubscribe function. See [Network events](#network-events--capturing-requests). |
| `captureRequests(urlPattern, fn, opts?)` | Run `fn` while collecting network requests whose URL matches `urlPattern` (substring or RegExp). Returns `{ requests, count }`. See [Network events](#network-events--capturing-requests). |
| `snapshotInteractive({ max? })` | Return `{ url, title, count, elements }` for all visible interactive elements on the page (links, buttons, inputs, selects, `[role]`, `[tabindex]`). Each element is a compact object (`{ tag, id?, classes?, role?, text?, href?, type?, placeholder?, value? }`). Use this instead of dumping `outerHTML` — you get the signal without the noise. |
| `checkpoint` | Deep-freeze object. `checkpoint.save({ label })` captures cookies + localStorage + sessionStorage + URL + scroll to disk. `checkpoint.restore(idOrLabel)` reloads it. `.list()`, `.remove(idOrLabel)`. See [Checkpoints](#checkpoints--deep-freeze-state). |
| `breadcrumb` | Action recorder. `breadcrumb.start({ label })` subscribes to nav/POST events. `.note(action, detail)` records manual actions. `.snapshot()` / `.stop()` write to disk. `.replay(idOrLabel)` replays navigations on the current attached session (manual steps returned in `manualSteps`). `.list()`, `.remove(idOrLabel)`. See [Breadcrumbs](#breadcrumbs--record-and-replay-the-journey). |

`session` auto-routes to the active page target (set during `attach`). Browser-level
methods (`Browser.*`, `Target.*`) go to the browser endpoint. No domain is denied
— you have the full CDP surface, including `Network`, `Page.captureScreenshot`,
`Browser.setDownloadBehavior`, `Target.attachToTarget`.

## Waiting: `waitForReady` is the universal poll primitive

`waitForReady({ check })` polls **any** JS expression in the page until it
returns truthy. It is not a hydration-specific tool — it's the universal
"wait until X is true" primitive. Use it for:

- **Readiness** — `document.readyState === 'complete'`
- **Content-waiting** — `document.body.innerText.includes('Welcome')`,
  `document.body.innerText.includes('No results found')`
- **Element-waiting** — `document.querySelector('#results')`,
  `document.querySelectorAll('table tbody tr').length > 0`
- **Any condition** — `myApp.loaded && !myApp.spinner`

`check` can be **any** expression that returns a truthy/falsy value, not just
`document.readyState`. If you find yourself writing a hand-rolled polling loop
(`while (!cond) { await sleep(...) }`), you're reinventing `waitForReady` —
use it instead.

```js
// Content-waiting: wait for specific text to appear (e.g. after an async action).
await waitForReady({
  check: 'document.body.innerText.includes("Export complete")',
  timeout: 30000,
  hint: 'export finished',
});

// Element-waiting: wait for a specific element.
await waitForReady({
  check: 'document.querySelector("#results tbody tr") !== null',
  timeout: 10000,
  hint: 'first result row',
});

// THEN read.
return await evalInPage('document.querySelector("h1").textContent');
```

> **Timeout auto-extends.** If `timeout` exceeds the eval body's own timeout
> (default 120s), the body timeout is automatically pushed out. So
> `waitForReady({ timeout: 180000 })` works without setting `--timeout`.

> **Timeouts include diagnostics.** On timeout, the error includes the `check`
> expression, how long it actually waited, `document.body.innerText.length`
> (is the page growing or stuck?), and the last 300 chars of body text (what's
> actually on screen) — so you can reason in one read instead of running a
> separate eval.

### Hydration is the common case

SPAs render skeleton/spinner placeholders for 1-3s before the real data. Reading
too early is the #1 source of wrong answers (empty rows, undercounted results,
stale counts). **Wait before you read** — and `waitForReady` is how.

The `--wait` flag is the one-shot form — it polls a page JS expression until truthy,
then runs the body:

```bash
cat <<'JS' | chrome-headcrab eval --name myagent --page --wait 'document.querySelectorAll("table tbody tr").length > 0' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return rows.map(r => r.textContent.trim());
JS
```

From the Node context, the equivalent is `waitForReady` (content check — preferred,
you know what "ready" means for this page) or `waitForDomStable` (framework-agnostic
fallback when you don't know the skeleton class):

```js
await waitForReady({
  check: 'document.querySelectorAll("table tbody tr").length > 0',
  timeout: 10000,
  hint: 'table rows present',
});

// Or, when you don't know what selector to check for:
await waitForDomStable({ timeout: 10000, hint: 'initial render' });

// THEN read.
return await evalInPage('document.querySelector("h1").textContent');
```

## Navigate

Prefer the `navigate()` helper — it does the nav AND waits for `readyState`:

```js
await navigate('https://example.com/page');   // returns once readyState === 'complete'
return await evalInPage('document.title');
```

The raw form (if you need a custom readiness check):

```js
await session.Page.navigate({ url: 'https://example.com/page' });
await waitForReady({ check: 'document.readyState === "complete"', hint: 'navigation' });
return await evalInPage('document.title');
```

The driver auto re-attaches to the page target after every main-frame
navigation (it listens for `Page.frameNavigated`). If a `session.*` call lands
during the brief re-attach window and fails with a session error, the driver
retries it once on the fresh session. So `Page.navigate`, `Page.reload`, and
SPA route changes no longer detach you — but always follow a navigation with a
`waitForReady` / `waitForDomStable` so you don't read mid-hydration.

## Read DOM text

The cleanest path is `--page --wait --stdin` — the wait hydrates, then the body runs
in the page directly, no `evalInPage` wrapper needed:

```bash
cat <<'JS' | chrome-headcrab eval --name myagent --page --wait 'document.querySelector("table tbody tr")' --stdin
const rows = [...document.querySelectorAll('table tbody tr')];
return rows.map(r => r.textContent.trim());
JS
```

From the Node context, the equivalent uses `evalInPage`. The expression must be a
single expression — wrap multi-statement logic in an IIFE:

```js
return await evalInPage(`
  (() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    return rows.map(r => r.textContent.trim());
  })()
`);
```

### DOM nodes auto-describe

`evalInPage` (and therefore `--page` mode) automatically describes DOM nodes in the
return value. Returning `document.querySelector('h1')` yields a descriptive string
like `"<h1 class=\"title\">Welcome</h1>"` instead of `{}` (the silent empty you'd
get from raw CDP `returnByValue`). This works recursively through arrays and
objects too:

```js
// In Node context:
return await evalInPage(() => document.querySelectorAll('a'));

// → [
//   '<a href="/login" text="Sign in">',
//   '<a href="/signup" text="Sign up">',
//   '<a class="nav.logo" href="/" text="Home">'
// ]
```

### Snapshot interactive elements

When you don't know the page structure, prefer `snapshotInteractive()` over dumping
`outerHTML` — you get a clean list of every actionable element without megabytes of
div noise:

```js
const snap = await snapshotInteractive();
// snap.elements[0] → { tag: 'a', text: 'Sign in', href: '/login' }
// snap.elements[1] → { tag: 'input', type: 'email', placeholder: 'you@x.com', name: 'email' }
// snap.elements[2] → { tag: 'button', text: 'Continue', classes: ['btn', 'btn-primary'] }
return snap;
```

## Click

```js
// Direct DOM click — works for plain elements.
await evalInPage('document.querySelector("button#submit").click()');

// For elements where the React handler is on a parent, or coordinates matter,
// use Input.dispatchMouseEvent via the node's bounding box.
await evalInPage(`
  const el = document.querySelector('[aria-label="Drafts"]');
  const r = el.getBoundingClientRect();
  window.__click = { x: r.x + r.width/2, y: r.y + r.height/2 };
`);
const c = await evalInPage('window.__click');
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
```

## Drag and drop

**The #1 gotcha: `buttons` does not persist across events.** CDP's
`Input.dispatchMouseEvent` does not carry "button held down" state from one
call to the next — each intermediate `mouseMoved` needs its own explicit
`buttons` bitmask (`1` = left) or the page sees `MouseEvent.buttons === 0`
throughout the "drag." Any drag-and-drop logic gated on `event.buttons`
(true of most custom canvas/editor drag implementations) then never
recognizes an active drag: it sees mousedown, a series of *buttonless*
hover-moves, then mouseup — which the page may interpret as an unrelated
cursor wander, not a drag. This has caused real incidents: a dragged element
silently dropped into the wrong container because the page's hit-testing saw
no continuous held-button state to gate on.

Use the `dragMouse({ from, to, steps?, stepDelay?, settleDelay? })` helper —
it stamps `buttons: 1` on every move, interpolates linearly so movement-aware
drag libraries see a realistic path (not a teleport), and sends one final
move at the exact drop point before releasing (some libraries key the drop
target off the last `mousemove`, not `mouseup`):

```js
const el = await evalInPage(() => {
  const r = document.querySelector('.draggable-box').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await dragMouse({ from: el, to: { x: el.x, y: el.y + 200 }, steps: 20, stepDelay: 40 });
```

If you must hand-roll it (e.g. custom easing), the equivalent raw sequence is:

```js
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: 700, y: 600, button: 'left', buttons: 1, clickCount: 1 });
for (let i = 1; i <= 20; i++) {
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 700, y: 600 + i * 15, button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 40));
}
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 700, y: 900, button: 'left', buttons: 0, clickCount: 1 });
```

**Native HTML5 drag-and-drop is different and out of scope for this helper.**
Elements using `draggable="true"` fire `dragstart`/`dragover`/`drop` events,
not mouse events — synthetic `Input.dispatchMouseEvent` calls do not trigger
them. For those, dispatch `DragEvent`s directly in the page (via `evalInPage`)
with a `DataTransfer` object, or check whether CDP's experimental
`Input.dispatchDragEvent` is available in the installed Chromium version.

**Fragile targets need generous interpolation, not more retries.** Editor-style
canvases (Wix Editor, Figma-like tools) often have snap zones and
section-boundary logic that's finicky even for a human with a real mouse. If
a drag keeps overshooting or landing in the wrong place, first try more/smaller
steps (`steps: 30+`) and a longer `stepDelay` before concluding the drag
itself is broken — and consider whether the drop target needs to exist/be
sized correctly *before* the drag (e.g. grow a container) rather than after.

## Fill inputs

The ergonomic helper handles focus + select-all + delete + insert in one call,
and **replaces** the value (raw `Input.insertText` appends):

```js
// Works on plain HTML AND React-controlled inputs.
const newVal = await typeInto('input[placeholder*="Search"]', 'HIPAA');
return newVal;
```

**Form submit + read the result page.** When a form submit triggers a
server-side navigation, use `waitForNavigation` to arm a listener *before* the
submit, then read the destination page once it settles — no blind polling:

```js
// Navigate to the form page FIRST, outside waitForNavigation.
await navigate('https://example.com/login', { hint: '#username' });
const dest = await waitForNavigation(
  { hint: 'login result' },
  async () => {
    await typeInto('#username', 'wronguser');
    await typeInto('#password', 'wrongpass');
    await evalInPage('document.querySelector("form").submit()');
  },
);
// dest is the destination URL; page is ready for reads.
const result = await evalInPage(() => ({
  url: location.href,
  hasError: !!document.querySelector('.alert-danger'),
  bodyText: document.body.innerText.substring(0, 500),
}));
return { dest, ...result };
```

> **Don't `navigate()` inside the `waitForNavigation` trigger.** `navigate()`
> itself fires `Page.frameNavigated`, which the listener will catch as the
> "navigation" and return early — before your submit even runs. Navigate to the
> form page first, then arm the listener around just the submit action.

> **`evalInPage` accepts an arrow function.** The quoting of nested strings and
> regexes inside `evalInPage('...')` is painful (you have to double-escape).
> Pass an arrow function instead — it runs in the page with native quoting:
>
> ```js
> // Painful: nested quotes, double-escaped regex
> await evalInPage('(() => { const m = document.body.innerHTML.match(/<a[^>]*href="([^"]*)"/); return m ? m[1] : null; })()');
>
> // Clean: arrow function, native quoting
> await evalInPage(() => {
>   const m = document.body.innerHTML.match(/<a[^>]*href="([^"]*)"/);
>   return m ? m[1] : null;
> });
> ```

> **Selector tip:** don't copy selectors from docs verbatim — sites change.
> Verify a selector exists with `evalInPage('document.querySelector("...")?.tagName')`
> before typing into it. (E.g. Google's search box moved from `input[name=q]`
> to `textarea[name=q]`.)

## Downloads

Set the download behavior before clicking the download trigger:

```js
await session.Browser.setDownloadBehavior({ behavior: 'allow', downloadPath: '/tmp/chrome-headcrab-downloads' });
// ...click the export button, fill the form, click "Generate CSV"...
// The download is async on the browser side; sleep briefly to let it start,
// then verify on disk from the shell after eval returns.
await new Promise(r => setTimeout(r, 2000));
```

Then from bash: `ls -la /tmp/chrome-headcrab-downloads/` to confirm the file landed. For
robust verification, poll the directory from bash (Node can't easily stat the
file inside the driver context).

## Cross-origin iframes

The active target is the parent page. To read an iframe's `src` you don't need to
attach — it's in the parent DOM:

```js
return await evalInPage('document.querySelector("iframe")?.src');
```

To *interact with* the iframe's content, attach to its target:

```js
const targets = await listPageTargets();
// The iframe shows up as an iframe target in Target.getTargets:
const all = await session.Target.getTargets({});
const iframe = all.targetInfos.find(t => t.type === 'iframe');
if (iframe) await use(iframe.targetId);
return await evalInPage('document.title');  // now reads the iframe's document
```

## Network events / capturing requests

CDP pushes events (`Network.requestWillBeSent`, `Page.frameNavigated`, etc.)
as you drive the page. The driver subscribes to the `Page`, `Runtime`, `DOM`,
and `Network` domains automatically on attach — **you do not need to (and
should not) call `Network.enable` / `Page.enable` yourself.**

### `onEvent(method, fn)`

Subscribe to a single CDP event. `method` is the **full event name** as a
string (e.g. `'Network.requestWillBeSent'`). `fn` receives `(params, sessionId)`.
Returns an unsubscribe function — **call it when you're done** so listeners
don't pile up across evals.

```js
const seen = [];
const unsub = onEvent('Network.requestWillBeSent', (p) => {
  if (p.request.url.includes('/api/')) seen.push({ url: p.request.url, method: p.request.method });
});
// ...trigger the action that fires the requests...
await evalInPage('document.querySelector("#load-more").click()');
await waitForDomStable({ hint: 'requests settled' });
unsub();
return seen;
```

### `captureRequests(urlPattern, fn, opts?)` — the ergonomic wrapper

The common case is "run this action and tell me what API calls it made."
`captureRequests` wires up the request/response/body listeners for you, runs
`fn`, waits a beat for trailing responses, unsubscribes, and returns the
collected records.

- `urlPattern`: substring or RegExp. Substrings are escaped to literal matches.
- `fn`: async function that performs the click/navigate/etc.
- `opts.body` (default `true`): fetch response bodies via `Network.getResponseBody`.
- Returns `{ requests: [{ requestId, url, method, headers, postData, status, responseHeaders, mimeType, body }], count }`.

```js
const { requests, count } = await captureRequests('/rest/policies', async () => {
  await evalInPage('document.querySelector("[aria-label=Filter]").click()');
  await waitForDomStable({ hint: 'filter results loaded' });
});
return { count, first: requests[0] };
```

### Pitfalls (read these once)

- **`session.Network.requestWillBeSent(...)` is NOT a thing.** That name is an
  *event*, not a method. Calling it sends `Network.requestWillBeSent` as a CDP
  *method*, which doesn't exist — CDP returns an error and the call rejects.
  Events are consumed via `onEvent` / `captureRequests`, never via `session.*`.
  This was the single biggest source of driver crashes in the incident agent.
- **`Page.reload({})` inside an eval is fine now** — the driver auto re-attaches
  after the reload's `frameNavigated`. Previously it detached the target and
  every subsequent call failed. You still must `waitForReady` after.
- **Listeners persist for the life of the driver unless you unsubscribe.** If
  you `onEvent` inside an `eval` and don't `unsub()`, the listener survives
  into the next eval and keeps firing. Prefer `captureRequests`, which
  auto-unsubscribes.
- **`requestWillBeSent` can fire multiple times for one logical request**
  (redirects, service-worker handoffs). If you de-dupe low-level `onEvent`
  output, key by `requestId`. `captureRequests` already de-dupes for you.
- **Readiness checks should assert a content selector, not just a URL substring.**
  Error/redirect pages (CAPTCHAs, bot-detection "sorry" pages, login walls)
  often echo query params, so a check like `location.search.includes('q=')`
  passes on the wrong page. Assert something like
  `document.querySelector('#search h3')` instead — a node that only exists on
  the page you actually want.

## Traffic interception (mocking / blocking / rewriting)

The `Fetch` domain is the headline power-user capability — you can block requests,
mock responses, and rewrite headers before they're sent. This is what the "raw
CDP" design exists to unlock.

```js
// Block all requests to an ad/analytics domain.
await session.Fetch.enable({ patterns: [{ urlPattern: '*doubleclick.net*' }] });
const unsub = onEvent('Fetch.requestPaused', async (p) => {
  // Inspect p.request.url / p.request.headers, then either:
  await session.Fetch.failRequest({ requestId: p.requestId, errorReason: 'BlockedByClient' });
  // ...or let it through: await session.Fetch.continueRequest({ requestId: p.requestId });
});
// ...do work...
unsub();
await resetInterception();   // MUST disable before navigating, or the loader wedges
```

**Critical pitfall:** if you `Fetch.failRequest` on a **main-frame** request (or
forget to `Fetch.disable`), the page's loader wedges and every subsequent nav
times out. Two recoveries:

1. Call `resetInterception()` (disables `Fetch` + clears interception patterns),
   then `navigate()` — which now auto-creates a fresh target if the old one's
   loader is stuck.
2. Or `await resetInterception()` then `navigate(url)` — `navigate` handles the
   fresh-target path internally if it detects an aborted load.

`Network.setExtraHTTPHeaders({ headers })` works and **persists across navigations** —
remember to reset it (`session.Network.setExtraHTTPHeaders({ headers: {} })`) when done,
or it poisons every later request.

## Multi-tab

Headcrab attaches to whatever Chrome already has open. Switch among existing
tabs, or open a new one in the background (default):

```js
const targets = await listPageTargets();
const gmail = targets.find(t => /mail\.google\.com/.test(t.url));
if (gmail) await use(gmail.targetId);  // attach only — no OS focus steal in bg mode

// Or open a fresh tab without yanking the user's window:
const id = await createPage('https://example.org/');  // Target.createTarget({ background: true })
await use(id);

// use() enables read domains on the new session, so onEvent/captureRequests work
// immediately even without a subsequent navigation.
return await evalInPage('document.title');
```

Only pass `{ foreground: true }` / call `activateTarget` / `bringToFront` when
you intentionally want Chrome raised.

## Screenshots

```js
const { data } = await session.Page.captureScreenshot({ format: 'png' });
return data;  // base64 PNG — write to disk from bash or pass to the caller
```

The reply is `{"value":"<base64>"}`. To save it as a PNG from bash:

```bash
chrome-headcrab eval 'const { data } = await session.Page.captureScreenshot({ format: "png" }); return data;' \
  | jq -r '.value' | base64 -d > /tmp/shot.png
```

## Multi-step scripts

For flows longer than a few lines, pipe a heredoc to `--stdin` (preferred — no temp
file, no shell-quoting pain):

```bash
cat <<'JS' | chrome-headcrab eval --name myagent --stdin
await navigate('https://example.com');
await waitForReady({ check: 'document.readyState === "complete"', hint: 'load' });
const title = await evalInPage('document.title');
const links = await evalInPage('[...document.querySelectorAll("a")].map(a => a.href)');
return { title, links };
JS
```

Or write to a file and use `script` / `eval --file`:

```bash
cat > /tmp/flow.js <<'EOF'
await navigate('https://example.com');
await waitForReady({ check: 'document.readyState === "complete"', hint: 'load' });
const title = await evalInPage('document.title');
const links = await evalInPage('[...document.querySelectorAll("a")].map(a => a.href)');
return { title, links };
EOF
chrome-headcrab script --name myagent /tmp/flow.js
```


## Checkpoints — deep-freeze state

`checkpoint` captures the full restorable state of the page (cookies,
localStorage, sessionStorage, current URL, scroll position) to a JSON file.
Restore it later into the same or a different browser to land exactly where
you left off — no action replay needed. Think "save game."

### `checkpoint.save({ label })` → `{ id, label, path, bytes, summary }`

```js
const cp = await checkpoint.save({ label: 'after-login-and-filter' });
// cp = {
//   id: "cp_20260713-160500_a1b2",
//   label: "after-login-and-filter",
//   path: "~/.cache/chrome-headcrab/checkpoints/cp_20260713-160500_a1b2.json",
//   bytes: 4823,
//   summary: { cookies: 12, localStorage: 8, sessionStorage: 2, url: "https://app.example.com/dashboard" }
// }
return cp;
```

### `checkpoint.restore(idOrLabel)` → `{ id, found, applied, navigatedTo, warnings }`

```js
const r = await checkpoint.restore('after-login-and-filter');
// r = {
//   id: "cp_20260713-160500_a1b2",
//   found: true,
//   applied: { cookies: 12, localStorage: 8, sessionStorage: 2 },
//   navigatedTo: "https://app.example.com/dashboard",
//   warnings: []   // partial failures (e.g. one cookie rejected) land here
// }
return r;
```

`idOrLabel` matches on exact id OR case-insensitive label substring (newest on
ambiguity). Restore is **defensive**: each step is independently try/caught, so
a cookie-set failure doesn't block storage restore — failures collect in
`warnings` and the rest still applies.

After `restore`, follow up with `waitForReady({ check })` if the destination
page needs hydration before you read it.

### `checkpoint.list()` / `checkpoint.remove(idOrLabel)`

```js
return checkpoint.list();
// [{ id, label, createdAt, url, title, bytes }, ...]  // newest first

await checkpoint.remove('after-login-and-filter');  // delete the file
```

Files: `~/.cache/chrome-headcrab/checkpoints/cp_*.json` (the label lives inside the
JSON only, never the filename).

### When to use checkpoints

- **Roll back after a destructive action** — save before delete/submit, restore
  to undo.
- **Skip a long login + nav flow later in this session** — save once, restore
  after a destructive step or re-nav.
- **Capture state for offline inspection** — the JSON is plain, read it with
  file tools.

## Breadcrumbs — record and replay the journey

`breadcrumb` records the **meaningful actions** of a session (top-frame
navigations via CDP events, POST requests, and manual `note`s for clicks/types)
and replays the restorable ones on the current attached session. Complements checkpoints:
breadcrumbs replay the *journey*, checkpoints restore the *destination*.

### `breadcrumb.start({ label })` → `{ id, label, path, recording }`

Subscribes to `Page.frameNavigated` (top-frame only — child iframes are
filtered) and `Network.requestWillBeSent` (POSTs only — GETs are too noisy).

```js
const bc = breadcrumb.start({ label: 'policy-draft-flow' });
// bc = { id: "bc_20260713-160500_a1b2", label: "policy-draft-flow",
//        path: "...", recording: { eventCount: 0, status: "recording" } }
return bc;
```

### `breadcrumb.note(action, detail)` → `{ recorded, index }`

Records a manual action CDP events don't capture. Use this after every click,
type, or submit so the trail is complete:

```js
breadcrumb.note('click', { selector: '#login-btn' });
breadcrumb.note('type',  { selector: '#email', text: 'a@b.com' });
breadcrumb.note('custom', { step: 'accepted-cookie-banner' });
```

### `breadcrumb.snapshot()` / `breadcrumb.stop()` → `{ id, label, eventCount, events, path }`

Both write the recording to disk as pretty JSON. `stop` also unsubscribes the
CDP event listeners and marks the recording stopped. Use `snapshot` to write
intermediate checkpoints of the trail without stopping; use `stop` when done.

### `breadcrumb.replay(idOrLabel)` → `{ stepsApplied, stepsSkipped, errors, finalUrl, manualSteps }`

Replays against the **current** browser:

```js
const r = await breadcrumb.replay('policy-draft-flow');
// r = {
//   stepsApplied: 2,     // navigations that ran
//   stepsSkipped: 1,     // POSTs attempted but expected to fail (CORS, expired CSRF)
//   errors: [{ index: 3, error: "NetworkError..." }],
//   finalUrl: "https://app.example.com/dashboard",
//   manualSteps: [       // actions YOU must redo — not auto-replayable
//     { type: "action", action: "click", detail: { selector: "#login-btn" } },
//     { type: "action", action: "type",  detail: { selector: "#email", text: "a@b.com" } }
//   ]
// }
return r;
```

**Replay is honest, not theater:**
- **Navigations** work (counted in `stepsApplied`).
- **POSTs** are best-effort via in-page `fetch` — expected to fail due to CORS
  or expired CSRF/auth. They're attempted, counted in `stepsSkipped`, and any
  error is captured in `errors`. The agent should treat these as informational.
- **Manual actions** (clicks/types) are returned verbatim in `manualSteps`. The
  element may not be present at replay time, so the agent must redo them in the
  right order, waiting for each target to appear.

### `breadcrumb.list()` / `breadcrumb.remove(idOrLabel)`

```js
return breadcrumb.list();
// [{ id, label, startedAt, finishedAt, eventCount, bytes }, ...]  // newest first

await breadcrumb.remove('policy-draft-flow');
```

Files: `~/.cache/chrome-headcrab/breadcrumbs/bc_*.json`.

### When to use breadcrumbs vs checkpoints

| Goal | Use |
|---|---|
| Roll back after a destructive action | **checkpoint** save → act → restore |
| Skip a long login + nav flow later in this session | **checkpoint** save once → restore in-place / after re-nav |
| Reproduce a multi-step journey on a clean slate | **breadcrumb** record → replay (redo `manualSteps`) |
| Capture state for offline inspection | **checkpoint** save (the JSON is readable) |
| Resume a flow that needs real clicks in order | **breadcrumb** replay navigations, redo `manualSteps` |

## Error handling

- A failed CDP call rejects with `Error: CDP <code>: <message>`.
- A failed `evalInPage` (JS exception in the page) rejects with `Error: page JS error: <description>`.
- A failed top-level `eval` body rejects with the error message and stack in the reply JSON.
- A timeout in `waitForReady` rejects with a labeled message that **includes
  page diagnostics**: the `check` expression, elapsed time, `document.body.innerText.length`,
  and the last 300 chars of body text — so you can reason about why it timed out
  in one read instead of running a separate eval. `waitForDomStable` rejects
  with a labeled message.
- If your `waitForReady({ check })` expression itself throws (typo'd selector, runtime error),
  the error is surfaced immediately as `waitForReady check threw: ...` rather than timing out.
- A `session.*` call that fails because the page navigated is auto-retried once after re-attach.
- The eval body has a **120s default timeout** (overridable via `chrome-headcrab eval --timeout <ms>`
  or the request's `timeout` field; capped at 600000ms / 10min). An await-yielding runaway
  loop (`while(true){ await something() }`) is caught and returns an error. A **purely
  synchronous** infinite loop (`while(true){}`) cannot be interrupted from the same process
  and will wedge the driver — the only recovery is `chrome-headcrab detach` + `attach` (Allow again).
  **Note:** if a `waitForReady({ timeout })` call inside an eval needs more time than
  the body timeout, the body timeout is automatically extended to accommodate it —
  so long polls work without fiddling with `--timeout`.

### Return contract (what serializes, what silently empties)

The eval's return value is JSON-serialized. Most values work fine, but some silently
produce `{}` (empty) — always read primitive values, not live objects:

| Return value | Result | Notes |
|---|---|---|
| `string`, `number`, `boolean`, `null` | works | |
| `undefined` | `{"value":null}` | coerced for you (not dropped) |
| `BigInt` | `{"value":"123n"}` | stringified with `n` suffix |
| object with circular refs | `{"value":{...,"[Circular]":"..."}}` | no longer hangs |
| plain `{a:1}` / arrays | works | |
| `Map`, `Set` | `{"value":{}}` **silent empty** | spread first: `[...map.entries()]` |
| DOM node (`document.body`) | `{"value":{}}` **silent empty** | read `.textContent` / `.value` instead |
| `{ a: undefined }` | `{"value":{"a":null}}` | `undefined` keys are coerced to `null` |

> **Rule of thumb:** `return await evalInPage("el.textContent")`, never
> `return await evalInPage("el")`. Pull the primitive (string/number) out of the
> page in the same expression that reads the node.

### Recovering from a closed page (`window.close()`)

If the page closes itself (`window.close()`, some OAuth popups), the driver's
auto-re-attach will **create a fresh `about:blank` target** and resume on it.
So you won't be left stranded — but anything you had on the old page (DOM state,
form input) is gone. To drive a specific URL after a close, just call
`navigate(url)` and the fresh target will load it.
