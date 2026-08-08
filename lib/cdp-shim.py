#!/usr/bin/env python3
"""CDP discovery + Origin-stripping WebSocket proxy for Google Chrome.

Chrome on :9222 (DevToolsActivePort) speaks CDP over the browser websocket, but:
  - HTTP /json/* returns 404
  - WS upgrades that include an Origin header get 403

Puppeteer/connectOverCDP needs both. This shim provides a headcrab-native HTTP /json facade for tools that need discovery:
  client  ->  http://127.0.0.1:9224  ->  discovery JSON
  client  ->  ws://127.0.0.1:9224/...  ->  Chrome :9222 (Origin stripped)
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ACTIVE = Path(
    os.environ.get(
        "HC_CHROME_PROFILE",
        str(Path.home() / ".config/google-chrome"),
    )
) / "DevToolsActivePort"
CHROME_HOST = "127.0.0.1"
SHIM_HOST = "127.0.0.1"
SHIM_PORT = int(os.environ.get("HC_SHIM_PORT", "9224"))


def read_active() -> tuple[int, str]:
    lines = ACTIVE.read_text().strip().splitlines()
    port = int(lines[0])
    path = lines[1] if len(lines) > 1 else ""
    if not path.startswith("/"):
        path = "/" + path
    return port, path


def shim_ws(path: str) -> str:
    return f"ws://{SHIM_HOST}:{SHIM_PORT}{path}"


def chrome_ws(port: int, path: str) -> str:
    return f"ws://{CHROME_HOST}:{port}{path}"


class Cdp:
    def __init__(self, port: int, path: str):
        self.port = port
        self.path = path
        self.reader = None
        self.writer = None
        self.data = b""
        self._id = 0

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection(CHROME_HOST, self.port)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {CHROME_HOST}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.writer.write(req.encode())
        await self.writer.drain()
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = await self.reader.read(1024)
            if not chunk:
                raise RuntimeError("CDP handshake closed")
            buf += chunk
        head, self.data = buf.split(b"\r\n\r\n", 1)
        if b"101" not in head.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"CDP handshake failed: {head[:200]!r}")

    def mask_frame(self, payload: bytes, opcode: int = 1) -> bytes:
        mask = os.urandom(4)
        header = bytearray([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", n)
        header += mask
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return bytes(header) + body

    async def need(self, n: int) -> bytes:
        while len(self.data) < n:
            chunk = await self.reader.read(4096)
            if not chunk:
                raise RuntimeError("CDP connection closed")
            self.data += chunk
        out, self.data = self.data[:n], self.data[n:]
        return out

    async def read_frame(self):
        b = await self.need(2)
        opcode = b[0] & 0x0F
        masked = b[1] & 0x80
        length = b[1] & 0x7F
        if length == 126:
            length = struct.unpack("!H", await self.need(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", await self.need(8))[0]
        mask = await self.need(4) if masked else None
        payload = await self.need(length)
        if mask:
            payload = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
        return opcode, payload

    async def call(self, method: str, params=None):
        self._id += 1
        mid = self._id
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        self.writer.write(self.mask_frame(json.dumps(msg).encode()))
        await self.writer.drain()
        while True:
            opcode, payload = await self.read_frame()
            if opcode != 1:
                continue
            obj = json.loads(payload)
            if obj.get("id") == mid:
                return obj

    async def close(self):
        if self.writer is not None:
            self.writer.close()


def run_coro(coro):
    return asyncio.run(coro)


async def browser_version(port: int, path: str):
    c = Cdp(port, path)
    await c.connect()
    try:
        return (await c.call("Browser.getVersion"))["result"]
    finally:
        await c.close()


async def list_pages(port: int, path: str):
    c = Cdp(port, path)
    await c.connect()
    try:
        raw = await c.call("Target.getTargets")
    finally:
        await c.close()
    infos = (raw.get("result") or {}).get("targetInfos") or []
    out = []
    for t in infos:
        info = t.get("targetInfo", t)
        if info.get("type") != "page":
            continue
        tid = info.get("targetId")
        page_path = f"/devtools/page/{tid}"
        out.append(
            {
                "description": "",
                "devtoolsFrontendUrl": f"/devtools/inspector.html?ws={SHIM_HOST}:{SHIM_PORT}{page_path}",
                "id": tid,
                "title": info.get("title") or "",
                "type": "page",
                "url": info.get("url") or "",
                "webSocketDebuggerUrl": shim_ws(page_path),
            }
        )
    return out


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_ws_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    try:
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = await reader.read(1024)
            if not chunk:
                writer.close()
                return
            buf += chunk
            if len(buf) > 65536:
                writer.close()
                return
        head, rest = buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin1", errors="replace").split("\r\n")
        req_line = lines[0]
        parts = req_line.split()
        if len(parts) < 2 or parts[0] != "GET":
            writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return
        path = parts[1]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        if headers.get("upgrade", "").lower() != "websocket":
            # Non-WS accidentally hit the async server — ignore, HTTP server handles discovery.
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        chrome_port, browser_path = read_active()
        # Accept browser path or /devtools/page/<id>
        upstream_path = path
        if path in ("/", ""):
            upstream_path = browser_path

        key = headers.get("sec-websocket-key")
        if not key:
            writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            return

        # Connect upstream WITHOUT Origin (Chrome 403s Origin-bearing handshakes).
        up_reader, up_writer = await asyncio.open_connection(CHROME_HOST, chrome_port)
        up_key = base64.b64encode(os.urandom(16)).decode()
        up_req = (
            f"GET {upstream_path} HTTP/1.1\r\n"
            f"Host: {CHROME_HOST}:{chrome_port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {up_key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        up_writer.write(up_req.encode())
        await up_writer.drain()

        up_buf = b""
        while b"\r\n\r\n" not in up_buf:
            chunk = await up_reader.read(1024)
            if not chunk:
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                up_writer.close()
                return
            up_buf += chunk
        up_head, up_rest = up_buf.split(b"\r\n\r\n", 1)
        if b"101" not in up_head.split(b"\r\n", 1)[0]:
            print(f"[proxy] upstream reject for {upstream_path}: {up_head[:120]!r}", flush=True)
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            await writer.drain()
            writer.close()
            up_writer.close()
            return

        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        ).decode()
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        writer.write(resp.encode())
        await writer.drain()

        # Any body bytes already read belong to the WS stream.
        if rest:
            up_writer.write(rest)
            await up_writer.drain()
        if up_rest:
            writer.write(up_rest)
            await writer.drain()

        print(f"[proxy] {peer} <=> {upstream_path}", flush=True)
        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
    except Exception as e:
        print(f"[proxy] error {peer}: {e}", flush=True)
        try:
            writer.close()
        except Exception:
            pass


async def ws_proxy_main():
    server = await asyncio.start_server(handle_ws_client, SHIM_HOST, 0)
    # We need HTTP and WS on same port. Use a single asyncio server that demuxes.
    # Restart approach: one asyncio server for both.
    sockets = server.sockets
    # Cancel this placeholder — replaced by unified server below.
    server.close()
    await server.wait_closed()


async def unified_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, state: dict):
    peer = writer.get_extra_info("peername")
    try:
        # Peek first line to demux HTTP discovery vs WS upgrade without consuming forever
        first = await reader.readline()
        if not first:
            writer.close()
            return
        # Read remaining headers
        header_lines = [first]
        while True:
            line = await reader.readline()
            header_lines.append(line)
            if line in (b"\r\n", b"\n", b""):
                break
            if sum(len(x) for x in header_lines) > 65536:
                writer.close()
                return
        raw_head = b"".join(header_lines)
        text = raw_head.decode("latin1", errors="replace")
        lines = text.split("\r\n")
        req_line = lines[0]
        parts = req_line.split()
        if len(parts) < 2:
            writer.close()
            return
        method, path = parts[0], parts[1]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        is_ws = (
            method == "GET"
            and headers.get("upgrade", "").lower() == "websocket"
        )

        if is_ws:
            chrome_port, browser_path = read_active()
            upstream_path = path if path not in ("/", "") else browser_path
            # If client hits /devtools/browser/<anything>, use live browser path
            if path.startswith("/devtools/browser/"):
                upstream_path = browser_path

            key = headers.get("sec-websocket-key")
            if not key:
                writer.write(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                return

            up_reader, up_writer = await asyncio.open_connection(CHROME_HOST, chrome_port)
            up_key = base64.b64encode(os.urandom(16)).decode()
            up_req = (
                f"GET {upstream_path} HTTP/1.1\r\n"
                f"Host: {CHROME_HOST}:{chrome_port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {up_key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            )
            up_writer.write(up_req.encode())
            await up_writer.drain()

            up_buf = b""
            while b"\r\n\r\n" not in up_buf:
                chunk = await up_reader.read(1024)
                if not chunk:
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    writer.close()
                    up_writer.close()
                    return
                up_buf += chunk
            up_head, up_rest = up_buf.split(b"\r\n\r\n", 1)
            if b"101" not in up_head.split(b"\r\n", 1)[0]:
                print(f"[proxy] upstream reject {upstream_path}: {up_head[:160]!r}", flush=True)
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
                await writer.drain()
                writer.close()
                up_writer.close()
                return

            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            ).decode()
            writer.write(
                (
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
                ).encode()
            )
            await writer.drain()
            if up_rest:
                writer.write(up_rest)
                await writer.drain()

            print(f"[proxy] WS {peer} <=> chrome{upstream_path}", flush=True)
            await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))
            return

        # Plain HTTP discovery
        pth = path.split("?", 1)[0]

        def send_json(obj, code=200):
            body = json.dumps(obj).encode()
            writer.write(
                (
                    f"HTTP/1.1 {code} {'OK' if code == 200 else 'ERR'}\r\n"
                    "Content-Type: application/json; charset=UTF-8\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    "Access-Control-Allow-Origin: *\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                + body
            )

        try:
            chrome_port, browser_path = read_active()
            if pth in ("/json/version", "/json/version/"):
                ver = await browser_version(chrome_port, browser_path)
                send_json(
                    {
                        "Browser": ver.get("product", "Chrome"),
                        "Protocol-Version": ver.get("protocolVersion", "1.3"),
                        "User-Agent": ver.get("userAgent", ""),
                        "V8-Version": ver.get("jsVersion", ""),
                        "WebKit-Version": "537.36",
                        "webSocketDebuggerUrl": shim_ws(browser_path),
                    }
                )
            elif pth in ("/json", "/json/", "/json/list", "/json/list/"):
                send_json(await list_pages(chrome_port, browser_path))
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
        except Exception as e:
            send_json({"error": str(e)}, 500)
            await writer.drain()
        writer.close()
    except Exception as e:
        print(f"[proxy] client error {peer}: {e}", flush=True)
        try:
            writer.close()
        except Exception:
            pass


async def main_async():
    chrome_port, browser_path = read_active()
    ver = await browser_version(chrome_port, browser_path)
    pages = await list_pages(chrome_port, browser_path)
    print(f"Chrome {ver.get('product')} via {chrome_ws(chrome_port, browser_path)}", flush=True)
    print(f"PAGE_COUNT {len(pages)}", flush=True)
    for p in pages[:12]:
        print(f"PAGE {p['title'][:50]} | {p['url'][:100]}", flush=True)

    state = {}

    async def on_client(reader, writer):
        await unified_client(reader, writer, state)

    server = await asyncio.start_server(on_client, SHIM_HOST, SHIM_PORT)
    print(
        f"SHIM_READY http://{SHIM_HOST}:{SHIM_PORT} -> {chrome_ws(chrome_port, browser_path)} (Origin-stripped WS proxy)",
        flush=True,
    )
    async with server:
        await server.serve_forever()


def main():
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
