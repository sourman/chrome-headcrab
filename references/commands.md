# chrome-headcrab commands

## attach (alias: up)

```bash
chrome-headcrab attach [--name live] [--shim-port 9224] [--no-shim] [--bg|--fg] [--force] [--json]
```

Latch onto Google Chrome. Shows the Allow dialog unless a live driver already
exists for `--name`. Refuses to double-attach without `--force`.

| Flag | Effect |
|---|---|
| `--bg` / `--background` | Default. New tabs via `background: true`; focus emulation ON; no auto-activate. |
| `--fg` / `--foreground` | Intentionally raise Chrome on `createTarget` (sets `HC_BG=0`). |

Prints: `NAME`, `CHROME_PORT`, `CHROME_WS`, `HTTP`, `SOCKET`, `DRIVER_PID`, `BG`, …

## detach (alias: down)

```bash
chrome-headcrab detach [name]
```

Kills the driver (and shim if we started it and nothing else shares it).
**Does not** quit Chrome. Next attach re-prompts Allow.

## status (alias: list)

```bash
chrome-headcrab status
```

## doctor

```bash
chrome-headcrab doctor [name]
```

## tabs

```bash
chrome-headcrab tabs [--name live]
```

Lists page targets via the held driver (`Target.getTargets`).

## cdp / http

```bash
chrome-headcrab cdp [--name live]    # browser WS URL
chrome-headcrab http [--name live]   # discovery base, e.g. http://127.0.0.1:9224
```

## eval / script / repl

```bash
chrome-headcrab eval [--name live] [--page] [--wait '<check>'] [--timeout ms] \
                     [--stdin|--file f|'<js>']
chrome-headcrab script [--name live] [--page] [--wait '<check>'] <file.js>
chrome-headcrab repl [--name live]
```

Same semantics as chad-browser: `--page` runs in page context; default is Node
context with `session.*` and helpers.

## gc

Reap dead runfiles / orphan driver sockets.

## Env

| Var | Default | Meaning |
|---|---|---|
| `HC_CHROME_PROFILE` | `~/.config/google-chrome` | Chrome user-data dir |
| `HC_SHIM_PORT` | `9224` | HTTP discovery shim port |
| `HC_NAME` | `live` | Default attach name |
| `HC_BG` | `1` | Background / no OS focus steal. Set `0` for foreground. |
| `HC_MEMORY_DIR` | `~/.cache/chrome-headcrab/memory` | Driver memory store |

## Paths

| Path | Purpose |
|---|---|
| `~/.cache/chrome-headcrab/run/<name>.env` | Attach metadata |
| `$XDG_RUNTIME_DIR/chrome-headcrab/<name>.sock` | Driver Unix socket |
| `~/.cache/chrome-headcrab/driver-<name>.log` | Driver log |
| `~/.cache/chrome-headcrab/shim-<name>.log` | Shim log |
