#!/usr/bin/env python3
"""
Tiny local web server for the Canvassing Map.

Does two things:
  1. Serves the map files (like `python3 -m http.server`).
  2. Adds one endpoint, /api/refresh-fellows, that re-runs the export which
     pulls the latest ASSIGNED-volunteer counts from the staff schedule. This
     is what the "Update assigned counts" button in the map calls, so you can
     refresh the numbers without opening Finder/Terminal.

Started automatically by start_map.command. Local use only.
"""

import functools
import http.server
import json
import os
import socketserver
import subprocess
import sys

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
EXPORT = os.path.expanduser("~/bores-scheduling/scripts/export_fellow_availability.py")


class Handler(http.server.SimpleHTTPRequestHandler):
    def _refresh(self):
        try:
            r = subprocess.run(
                [sys.executable, EXPORT],
                capture_output=True, text=True, timeout=60,
            )
            ok = r.returncode == 0
            body = {"ok": ok, "output": (r.stdout or "") + (r.stderr or "")}
        except Exception as e:  # noqa: BLE001 - report any failure to the browser
            ok, body = False, {"ok": False, "error": str(e)}
        data = json.dumps(body).encode("utf-8")
        self.send_response(200 if ok else 500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path.split("?", 1)[0] == "/api/refresh-fellows":
            return self._refresh()
        self.send_error(404, "Not found")

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/refresh-fellows":
            return self._refresh()
        return super().do_GET()


if __name__ == "__main__":
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=ROOT)
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"Canvassing map running at http://localhost:{PORT}/index.html")
        print('The "Update assigned counts" button is enabled.')
        print("Keep this window open while you use the map. Close it to stop.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
