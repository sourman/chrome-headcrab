# chrome-headcrab vs chad-browser

Both expose a Unix-socket JS eval driver over CDP. They solve different problems.

## Use chad-browser when

- You want **isolation** (parallel agents, disposable profiles)
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
