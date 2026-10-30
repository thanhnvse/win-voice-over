"""Serves the project folder with the CSP that extension pages get.

The header goes on every response, including the worker script, so the harness breaks the
same way the extension would: blob: workers, eval and inline scripts are all blocked.
Usage: python test/serve.py [port]
"""
import http.server
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5310
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(ROOT)))
    print(f"serving {ROOT} on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()
