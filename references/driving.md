[~/work/chrome-headcrab/references/driving.md#D002]
1:# chrome-headcrab — driving the page
2:
3:> **chrome-headcrab note:** same driver surface as chad-browser. The browser is
4:> already running — you attach once (`chrome-headcrab attach`), then drive.
5:> Background / no-focus mode is **ON by default** (`HC_BG=1` / `--bg`). Prefer
6:> `createPage(url)` / `use(targetId)` / `evalInPage` over `Input.dispatch*` and
7:> never call `activateTarget`/`bringToFront` unless the user wants Chrome raised.
8:
9:The `eval` subcommand runs JS in one of two contexts:
10:
11:- **`--page`** — the JS runs in the page. `document.querySelector(...)` works directly.
12:  The body is auto-wrapped in `evalInPage(() => { ... })()` with IIFE detection —
13:  a bare expression returns its value; multi-statement bodies use `return`.
14:- **default (Node)** — the JS runs in the driver's Node process with the full CDP
15:  helper surface below in scope. The body is wrapped in an async function, so use
16:  `await` freely and **`return` the result**.
17:
18:Both modes accept `--stdin` (pipe a heredoc) and `--file <path>` as alternatives to
19:the inline positional `<js>` arg — use `--stdin` for anything with nested quotes.
20:
21:## What's in scope
22:
23:| Name | What it does |
24:|---|---|
25:| `session.<Domain>.<Method>(params)` | Full raw CDP surface. `session.Page.navigate(...)`, `session.Runtime.evaluate(...)`, `session.Input.insertText(...)`, etc. Domain/method names map 1:1 to CDP. |
26:| `evalInPage(jsExprOrFn)` | `Runtime.evaluate` with `returnByValue:true, awaitPromise:true`. Accepts **either** a string expression **or** an arrow function (preferred — no quoting hell). Returns the value directly. The expression runs in the page's JS context. |
27:| `navigate(url, { timeout?, hint? })` | `Page.navigate` + wait for `readyState === 'complete'`. Preferred over the raw two-step — eliminates the #1 wrong-answer source (reading mid-hydration after a nav). |
28:| `waitForNavigation({ timeout?, hint? }, trigger)` | Arm a `Page.frameNavigated` listener, run `trigger` (e.g. a form submit or button click that causes a server-side navigation), then wait for the destination to settle. Returns the destination URL. Solves the read-after-submit pattern. |
29:| `typeInto(selector, text, { delay? })` | Focus a field, select-all, delete, then `Input.insertText`. **Replaces** the value (unlike raw `insertText`, which appends). Works on React-controlled inputs. Throws clearly on readonly/disabled/hidden/contenteditable. Returns the field's new value. |
30:| `resetInterception()` | Disable `Fetch`/`Network.setRequestInterception`. Call after traffic-interception experiments (blocking/mocking) so the loader doesn't stay wedged. Safe when no interception is active. |
31:| `waitForReady({ check, timeout?, hint? })` | The **universal wait/poll** primitive. Polls ANY JS expression (in the page) until it returns truthy — use it for content-waiting (`document.body.innerText.includes("Done")`), element-waiting (`document.querySelector('#results')`), or readiness (`document.readyState === 'complete'`). Default timeout 10s, interval 300ms. `hint` is a human label included in the timeout error. If `check` itself throws, the error is surfaced immediately. On timeout, the error includes page diagnostics (body text length + last 300 chars, the check, elapsed time) so you can reason in one read. If `timeout` exceeds the eval body timeout, the body timeout is auto-extended. |
32:| `waitForDomStable({ timeout?, hint?, minStableMs? })` | Wait until `querySelectorAll('*').length` is unchanged across **3** consecutive polls AND no skeleton/spinner selectors present AND the stable window spans ≥ `minStableMs` (default 600ms). **Weak heuristic** — prefer `waitForReady({check})` against real content for production scraping. |
33:| `listPageTargets()` | Page targets from `Target.getTargets` (excludes chrome:// and devtools://). |
34:| `use(targetId)` | Switch the active target via `Target.attachToTarget`. For cross-origin iframes and multi-tab flows. |
35:| `createPage(url, { foreground? })` | Create a tab. Default respects **background mode** (`HC_BG=1`): `Target.createTarget({ background: true })` so Chrome stays headed but does not steal OS focus. Pass `{ foreground: true }` / use `activateTarget` / `bringToFront` only when you intentionally want attention. |
36:| `activateTarget(targetId?)` | Explicitly foreground a tab (`Target.activateTarget`). Opt-in; not called automatically in bg mode. |
37:| `bringToFront()` | `Page.bringToFront` on the active page. Opt-in focus steal. |
38:| `backgroundMode` | Boolean reflecting `HC_BG` for the live driver. |
39:
40:| `onEvent(method, fn)` | Subscribe to a CDP event. Returns an unsubscribe function. See [Network events](#network-events--capturing-requests). |
41:| `captureRequests(urlPattern, fn, opts?)` | Run `fn` while collecting network requests whose URL matches `urlPattern` (substring or RegExp). Returns `{ requests, count }`. See [Network events](#network-events--capturing-requests). |
42:| `snapshotInteractive({ max? })` | Return `{ url, title, count, elements }` for all visible interactive elements on the page (links, buttons, inputs, selects, `[role]`, `[tabindex]`). Each element is a compact object (`{ tag, id?, classes?, role?, text?, href?, type?, placeholder?, value? }`). Use this instead of dumping `outerHTML` — you get the signal without the noise. |
43:| `checkpoint` | Deep-freeze object. `checkpoint.save({ label })` captures cookies + localStorage + sessionStorage + URL + scroll to disk. `checkpoint.restore(idOrLabel)` reloads it. `.list()`, `.remove(idOrLabel)`. See [Checkpoints](#checkpoints--deep-freeze-state). |
44:| `breadcrumb` | Action recorder. `breadcrumb.start({ label })` subscribes to nav/POST events. `.note(action, detail)` records manual actions. `.snapshot()` / `.stop()` write to disk. `.replay(idOrLabel)` replays navigations on a fresh browser (manual steps returned in `manualSteps`). `.list()`, `.remove(idOrLabel)`. See [Breadcrumbs](#breadcrumbs--record-and-replay-the-journey). |
45:
46:`session` auto-routes to the active page target (set during `attach`). Browser-level
47:methods (`Browser.*`, `Target.*`) go to the browser endpoint. No domain is denied
48:— you have the full CDP surface, including `Network`, `Page.captureScreenshot`,
49:`Browser.setDownloadBehavior`, `Target.attachToTarget`.
50:
51:## Waiting: `waitForReady` is the universal poll primitive
52:
53:`waitForReady({ check })` polls **any** JS expression in the page until it
54:returns truthy. It is not a hydration-specific tool — it's the universal
55:"wait until X is true" primitive. Use it for:
56:
57:- **Readiness** — `document.readyState === 'complete'`
58:- **Content-waiting** — `document.body.innerText.includes('Welcome')`,
59:  `document.body.innerText.includes('No results found')`
60:- **Element-waiting** — `document.querySelector('#results')`,
61:  `document.querySelectorAll('table tbody tr').length > 0`
62:- **Any condition** — `myApp.loaded && !myApp.spinner`
63:
64:`check` can be **any** expression that returns a truthy/falsy value, not just
65:`document.readyState`. If you find yourself writing a hand-rolled polling loop
66:(`while (!cond) { await sleep(...) }`), you're reinventing `waitForReady` —
67:use it instead.
68:
69:```js
70:// Content-waiting: wait for specific text to appear (e.g. after an async action).
71:await waitForReady({
72:  check: 'document.body.innerText.includes("Export complete")',
73:  timeout: 30000,
74:  hint: 'export finished',
75:});
76:
77:// Element-waiting: wait for a specific element.
78:await waitForReady({
79:  check: 'document.querySelector("#results tbody tr") !== null',
80:  timeout: 10000,
81:  hint: 'first result row',
82:});
83:
84:// THEN read.
85:return await evalInPage('document.querySelector("h1").textContent');
86:```
87:
88:> **Timeout auto-extends.** If `timeout` exceeds the eval body's own timeout
89:> (default 120s), the body timeout is automatically pushed out. So
90:> `waitForReady({ timeout: 180000 })` works without setting `--timeout`.
91:
92:> **Timeouts include diagnostics.** On timeout, the error includes the `check`
93:> expression, how long it actually waited, `document.body.innerText.length`
94:> (is the page growing or stuck?), and the last 300 chars of body text (what's
95:> actually on screen) — so you can reason in one read instead of running a
96:> separate eval.
97:
98:### Hydration is the common case
99:
100:SPAs render skeleton/spinner placeholders for 1-3s before the real data. Reading
101:too early is the #1 source of wrong answers (empty rows, undercounted results,
102:stale counts). **Wait before you read** — and `waitForReady` is how.
103:
104:The `--wait` flag is the one-shot form — it polls a page JS expression until truthy,
105:then runs the body:
106:
107:```bash
108:cat <<'JS' | chrome-headcrab eval --name myagent --page --wait 'document.querySelectorAll("table tbody tr").length > 0' --stdin
109:const rows = [...document.querySelectorAll('table tbody tr')];
110:return rows.map(r => r.textContent.trim());
111:JS
112:```
113:
114:From the Node context, the equivalent is `waitForReady` (content check — preferred,
115:you know what "ready" means for this page) or `waitForDomStable` (framework-agnostic
116:fallback when you don't know the skeleton class):
117:
118:```js
119:await waitForReady({
120:  check: 'document.querySelectorAll("table tbody tr").length > 0',
121:  timeout: 10000,
122:  hint: 'table rows present',
123:});
124:
125:// Or, when you don't know what selector to check for:
126:await waitForDomStable({ timeout: 10000, hint: 'initial render' });
127:
128:// THEN read.
129:return await evalInPage('document.querySelector("h1").textContent');
130:```
131:
132:## Navigate
133:
134:Prefer the `navigate()` helper — it does the nav AND waits for `readyState`:
135:
136:```js
137:await navigate('https://example.com/page');   // returns once readyState === 'complete'
138:return await evalInPage('document.title');
139:```
140:
141:The raw form (if you need a custom readiness check):
142:
143:```js
144:await session.Page.navigate({ url: 'https://example.com/page' });
145:await waitForReady({ check: 'document.readyState === "complete"', hint: 'navigation' });
146:return await evalInPage('document.title');
147:```
148:
149:The driver auto re-attaches to the page target after every main-frame
150:navigation (it listens for `Page.frameNavigated`). If a `session.*` call lands
151:during the brief re-attach window and fails with a session error, the driver
152:retries it once on the fresh session. So `Page.navigate`, `Page.reload`, and
153:SPA route changes no longer detach you — but always follow a navigation with a
154:`waitForReady` / `waitForDomStable` so you don't read mid-hydration.
155:
156:## Read DOM text
157:
158:The cleanest path is `--page --wait --stdin` — the wait hydrates, then the body runs
159:in the page directly, no `evalInPage` wrapper needed:
160:
161:```bash
162:cat <<'JS' | chrome-headcrab eval --name myagent --page --wait 'document.querySelector("table tbody tr")' --stdin
163:const rows = [...document.querySelectorAll('table tbody tr')];
164:return rows.map(r => r.textContent.trim());
165:JS
166:```
167:
168:From the Node context, the equivalent uses `evalInPage`. The expression must be a
169:single expression — wrap multi-statement logic in an IIFE:
170:
171:```js
172:return await evalInPage(`
173:  (() => {
174:    const rows = [...document.querySelectorAll('table tbody tr')];
175:    return rows.map(r => r.textContent.trim());
176:  })()
177:`);
178:```
179:
180:### DOM nodes auto-describe
181:
182:`evalInPage` (and therefore `--page` mode) automatically describes DOM nodes in the
183:return value. Returning `document.querySelector('h1')` yields a descriptive string
184:like `"<h1 class=\"title\">Welcome</h1>"` instead of `{}` (the silent empty you'd
185:get from raw CDP `returnByValue`). This works recursively through arrays and
186:objects too:
187:
188:```js
189:// In Node context:
190:return await evalInPage(() => document.querySelectorAll('a'));
191:
192:// → [
193://   '<a href="/login" text="Sign in">',
194://   '<a href="/signup" text="Sign up">',
195://   '<a class="nav.logo" href="/" text="Home">'
196:// ]
197:```
198:
199:### Snapshot interactive elements
200:
201:When you don't know the page structure, prefer `snapshotInteractive()` over dumping
202:`outerHTML` — you get a clean list of every actionable element without megabytes of
203:div noise:
204:
205:```js
206:const snap = await snapshotInteractive();
207:// snap.elements[0] → { tag: 'a', text: 'Sign in', href: '/login' }
208:// snap.elements[1] → { tag: 'input', type: 'email', placeholder: 'you@x.com', name: 'email' }
209:// snap.elements[2] → { tag: 'button', text: 'Continue', classes: ['btn', 'btn-primary'] }
210:return snap;
211:```
212:
213:## Click
214:
215:```js
216:// Direct DOM click — works for plain elements.
217:await evalInPage('document.querySelector("button#submit").click()');
218:
219:// For elements where the React handler is on a parent, or coordinates matter,
220:// use Input.dispatchMouseEvent via the node's bounding box.
221:await evalInPage(`
222:  const el = document.querySelector('[aria-label="Drafts"]');
223:  const r = el.getBoundingClientRect();
224:  window.__click = { x: r.x + r.width/2, y: r.y + r.height/2 };
225:`);
226:const c = await evalInPage('window.__click');
227:await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
228:await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
229:```
230:
231:## Drag and drop
232:
233:**The #1 gotcha: `buttons` does not persist across events.** CDP's
234:`Input.dispatchMouseEvent` does not carry "button held down" state from one
235:call to the next — each intermediate `mouseMoved` needs its own explicit
236:`buttons` bitmask (`1` = left) or the page sees `MouseEvent.buttons === 0`
237:throughout the "drag." Any drag-and-drop logic gated on `event.buttons`
238:(true of most custom canvas/editor drag implementations) then never
239:recognizes an active drag: it sees mousedown, a series of *buttonless*
240:hover-moves, then mouseup — which the page may interpret as an unrelated
241:cursor wander, not a drag. This has caused real incidents: a dragged element
242:silently dropped into the wrong container because the page's hit-testing saw
243:no continuous held-button state to gate on.
244:
245:Use the `dragMouse({ from, to, steps?, stepDelay?, settleDelay? })` helper —
246:it stamps `buttons: 1` on every move, interpolates linearly so movement-aware
247:drag libraries see a realistic path (not a teleport), and sends one final
248:move at the exact drop point before releasing (some libraries key the drop
249:target off the last `mousemove`, not `mouseup`):
250:
251:```js
252:const el = await evalInPage(() => {
253:  const r = document.querySelector('.draggable-box').getBoundingClientRect();
254:  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
255:});
256:await dragMouse({ from: el, to: { x: el.x, y: el.y + 200 }, steps: 20, stepDelay: 40 });
257:```
258:
259:If you must hand-roll it (e.g. custom easing), the equivalent raw sequence is:
260:
261:```js
262:await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: 700, y: 600, button: 'left', buttons: 1, clickCount: 1 });
263:for (let i = 1; i <= 20; i++) {
264:  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x: 700, y: 600 + i * 15, button: 'left', buttons: 1 });
265:  await new Promise(r => setTimeout(r, 40));
266:}
267:await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: 700, y: 900, button: 'left', buttons: 0, clickCount: 1 });
268:```
269:
270:**Native HTML5 drag-and-drop is different and out of scope for this helper.**
271:Elements using `draggable="true"` fire `dragstart`/`dragover`/`drop` events,
272:not mouse events — synthetic `Input.dispatchMouseEvent` calls do not trigger
273:them. For those, dispatch `DragEvent`s directly in the page (via `evalInPage`)
274:with a `DataTransfer` object, or check whether CDP's experimental
275:`Input.dispatchDragEvent` is available in the installed Chromium version.
276:
277:**Fragile targets need generous interpolation, not more retries.** Editor-style
278:canvases (Wix Editor, Figma-like tools) often have snap zones and
279:section-boundary logic that's finicky even for a human with a real mouse. If
280:a drag keeps overshooting or landing in the wrong place, first try more/smaller
281:steps (`steps: 30+`) and a longer `stepDelay` before concluding the drag
282:itself is broken — and consider whether the drop target needs to exist/be
283:sized correctly *before* the drag (e.g. grow a container) rather than after.
284:
285:## Fill inputs
286:
287:The ergonomic helper handles focus + select-all + delete + insert in one call,
288:and **replaces** the value (raw `Input.insertText` appends):
289:
290:```js
291:// Works on plain HTML AND React-controlled inputs.
292:const newVal = await typeInto('input[placeholder*="Search"]', 'HIPAA');
293:return newVal;
294:```
295:
296:**Form submit + read the result page.** When a form submit triggers a
297:server-side navigation, use `waitForNavigation` to arm a listener *before* the
298:submit, then read the destination page once it settles — no blind polling:
299:
300:```js
…
318:```
…
344:
…
832:`navigate(url)` and the fresh target will load it.

[Showing lines 1-300 of 833. Use :301 to continue]