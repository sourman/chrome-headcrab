# Attach + Allow (Chrome 144+)

## Official flow

Chrome's intended path for coding agents (M144+):

1. User enables remote debugging at `chrome://inspect/#remote-debugging`
2. Client requests a remote debugging session (`--autoConnect` style, or a direct
   browser WebSocket connect)
3. Chrome shows **Allow remote debugging session?**
4. User clicks **Allow**
5. Banner: *Chrome is being controlled by automated test software*

Approval does **not** persist across new connections. There is no "Always allow"
yet ([chrome-devtools-mcp#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)).

Sources:

- https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session
- https://developer.chrome.com/blog/remote-debugging-port (Chrome 136: port flag ignored on default profile)

## What broke the naive approach

On a live Google Chrome default profile:

- Port `9222` may listen and `DevToolsActivePort` may exist
- HTTP `http://127.0.0.1:9222/json` and `/json/version` often return **404**
- The browser WebSocket from `DevToolsActivePort` **does** work after Allow
- Tools that require an HTTP discovery endpoint therefore need a shim

## What chrome-headcrab does

```
Google Chrome (:9222 WS only)
        │
        │  one authorized browser WebSocket (Allow once)
        ▼
 headcrab driver.mjs  ── Unix socket ──►  chrome-headcrab eval/tabs
        │
        └─ optional HTTP discovery shim (:9224 /json*) for browser tools
```

- `attach` reads `~/.config/google-chrome/DevToolsActivePort`
- Starts `lib/cdp-shim.py` on `:9224` (HTTP `/json` facade + WS proxy)
- Starts `lib/driver.mjs` against the Chrome browser WS (triggers Allow)
- Writes `~/.cache/chrome-headcrab/run/<name>.env` with SOCKET / PIDs
- Later commands **only** talk to the Unix socket

## Gotchas

1. **Re-attach = re-prompt.** `attach --force` and `detach` then `attach` show Allow again. Prefer `status` and reuse.
2. **Don't kill Chrome.** `detach` kills driver (+ owned shim) only.
3. **Raw `:9222` is not a discovery URL** under this flow. Use `chrome-headcrab http`.
4. **Multiple WS clients each prompt.** Browser-tool CDP attach + headcrab driver = two Allows unless they share one connection. Prefer one owner (headcrab) and drive through it.
5. **Chrome restart drops DevToolsActivePort / authorization.** Re-enable inspect UI if needed, then `attach` again.
6. **Profile path.** Default `~/.config/google-chrome`. Override with `HC_CHROME_PROFILE`.

## Doctor checklist

```bash
chrome-headcrab doctor
```

Expect:

- `DevToolsActivePort` present with port + `/devtools/browser/<uuid>`
- Chrome listening on that port
- After attach: `DRIVER=yes`, socket present, optional shim on `:9224`
