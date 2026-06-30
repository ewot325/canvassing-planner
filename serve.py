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
SCHED_SCRIPTS = os.path.expanduser("~/bores-scheduling/scripts")
EXPORT = os.path.join(SCHED_SCRIPTS, "export_fellow_availability.py")
PUSH_MEETING = os.path.join(SCHED_SCRIPTS, "push_meeting_point.py")
# push_meeting_point.py needs supabase + the service key, so run it with the
# scheduling project's venv (which has those) from the scripts dir (so its
# config.py loads scripts/.env). Fall back to the system python if no venv.
SCHED_PY = os.path.join(SCHED_SCRIPTS, "venv", "bin", "python")


def _json_response(handler, payload, ok):
    data = json.dumps(payload).encode("utf-8")
    handler.send_response(200 if ok else 500)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(data)


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
        _json_response(self, body, ok)

    def _fellow_availability(self):
        # Live assigned counts from the local scheduling snapshots (same data the
        # hosted Netlify function reads over HTTP).
        try:
            r = subprocess.run([sys.executable, EXPORT, "--stdout"],
                               capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and r.stdout.strip():
                _json_response(self, json.loads(r.stdout.strip().splitlines()[-1]), True)
                return
            _json_response(self, {"ok": False, "error": r.stderr or "no output"}, False)
        except Exception as e:  # noqa: BLE001
            _json_response(self, {"ok": False, "error": str(e)}, False)

    def _push_meeting(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b"{}"
        py = SCHED_PY if os.path.exists(SCHED_PY) else sys.executable
        try:
            r = subprocess.run([py, PUSH_MEETING], input=raw, capture_output=True,
                               timeout=60, cwd=SCHED_SCRIPTS)
            out = (r.stdout or b"").decode("utf-8").strip()
            err = (r.stderr or b"").decode("utf-8").strip()
            try:
                body = json.loads(out.splitlines()[-1]) if out else {"ok": False, "error": err or "no output"}
            except Exception:  # noqa: BLE001
                body = {"ok": r.returncode == 0, "error": err or out}
        except Exception as e:  # noqa: BLE001
            body = {"ok": False, "error": str(e)}
        _json_response(self, body, bool(body.get("ok")))

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/refresh-fellows":
            return self._refresh()
        if path == "/api/push-meeting":
            return self._push_meeting()
        self.send_error(404, "Not found")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/refresh-fellows":
            return self._refresh()
        if path == "/api/fellow-availability":
            return self._fellow_availability()
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
