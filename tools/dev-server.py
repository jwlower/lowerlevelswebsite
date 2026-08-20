#!/usr/bin/env python3
"""
Local development server for the Lower Levels site.

Plain `python -m http.server` sends Last-Modified headers, and browsers cache
ES modules aggressively enough that editing a .js file often leaves the old one
running -- which looks exactly like your change not working. This server sends
no-store on everything, so a plain refresh always picks up the current files.

Also serves on all interfaces by default, which is what you want for the LAN:
other devices can reach it at http://<your-ip>:8000/

    python tools/dev-server.py            # port 8000, all interfaces
    python tools/dev-server.py 8123       # a different port
    python tools/dev-server.py 8000 127.0.0.1   # localhost only
"""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    """Serves files with caching disabled and the JSON mime type set correctly."""

    # Some Windows registry setups map .js to the wrong type, which breaks
    # ES module loading with a strict-MIME error. Pin the ones that matter.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default: skip the successful asset noise.
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"

    root = Path(__file__).resolve().parent.parent
    handler = partial(NoCacheHandler, directory=str(root))
    server = ThreadingHTTPServer((host, port), handler)

    print(f"Serving {root}")
    print(f"  local:  http://localhost:{port}/")
    if host == "0.0.0.0":
        print(f"  LAN:    http://<your-ip>:{port}/dnd/character-creator.html")
        print("          (find your IP with `ipconfig` on Windows, `ip addr` on Linux)")
    print("Caching is disabled, so a refresh always loads your latest edits.")
    print("Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
