# chrome-headcrab vs chad-browser

Both expose a Unix-socket JS eval driver over CDP. They solve different problems.

**chrome-headcrab is single-session.** One real Google Chrome, one held driver.
No multi-agent parallelization, no per-agent profile clones. If you need that,
use chad-browser.

## Use chad-browser when

- You want **isolation** / disposable profiles (including parallel agents)
- You want logins seeded from `~/.config/chromium` without touching daily Chrome
- You need `up`/`down` to fully own browser lifecycle
- QA / adversarial / walking-sniper style workflows

## Use chrome-headcrab when

- You need the **exact** Google Chrome profile the human is using
- Tabs/extensions/enterprise SSO are already there and painful to recreate
- You're debugging "what I see in my real browser"
- You already paid the Allow dialog cost and want to keep driving

## Do not mix carelessly

- chad-browser talks to **Chromium clones** on ports 9300–9499
- chrome-headcrab talks to **Google Chrome** via DevToolsActivePort + shim `:9224`
- Pointing a browser tool at raw `http://127.0.0.1:9222` on modern Chrome often
  404s on `/json` — use `chrome-headcrab http` after attach
- Opening a second CDP client against the same Chrome usually re-triggers Allow

## Shared DNA

headcrab vendors the same driver surface as chad-browser (`session.*`,
`evalInPage`, `waitForReady`, checkpoint/breadcrumb helpers) so agent muscle
memory transfers. The CLI is intentionally smaller and attach-centric.

## References parity

| chad-browser | chrome-headcrab |
|---|---|
| `driving.md` | ported (+ `createPage` / bg helpers) |
| `workflows.md` | adapted for attach/detach (not up/down browser) |
| `commands.md` | attach-centric equivalent |
| `auth-and-cdp.md` | **intentionally omitted** — headcrab uses live Google Chrome auth, not profile seeding / sqlite cookie snapshots |
| (n/a) | `attach-and-allow.md` — Chrome 144+ Allow flow + discovery shim + `--bg` |
| (n/a) | `vs-chad-browser.md` — this file |
