#!/usr/bin/env python3
"""Transparent capture proxy: see the exact request an agent sends to a provider.

Forwards every POST to the upstream unchanged (streaming responses included)
and appends one JSON line per request to the log: path, status, seconds,
headers with the key redacted, the full request body and the first bytes of
the response. Use it when a provider fails for the agent but not for curl —
the difference is always in the request, and the agent's session file does
not keep it.

    python3 measure/capture-proxy.py https://gateway.example.com capture.jsonl [port]

Then point the provider's `baseUrl` in models.json at `http://127.0.0.1:<port>/<prefix>`
for one run and put it back. Replaying a captured body with curl reproduces
the failure outside the agent; trimming it field by field finds the cause.
Bodies contain the system prompt and tool schemas: keep the log out of the repo.
"""

import http.server
import json
import sys
import time
import urllib.error
import urllib.request

UPSTREAM = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else None
LOG = sys.argv[2] if len(sys.argv) > 2 else "capture.jsonl"
PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 8787
SECRET_HEADERS = {"x-api-key", "authorization", "x-bf-vk"}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        shown = {k: ("<redacted>" if k.lower() in SECRET_HEADERS else v) for k, v in self.headers.items()}
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method="POST")
        for k, v in self.headers.items():
            if k.lower() not in ("host", "content-length", "connection"):
                req.add_header(k, v)
        t0, status, head = time.time(), None, ""
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                status = r.status
                self.send_response(r.status)
                for k, v in r.getheaders():
                    if k.lower() not in ("transfer-encoding", "content-length", "connection"):
                        self.send_header(k, v)
                self.end_headers()
                while True:
                    chunk = r.read(4096)
                    if not chunk:
                        break
                    if len(head) < 600:
                        head += chunk.decode("utf-8", "replace")
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
            head = data.decode("utf-8", "replace")[:1500]
            self.send_response(e.code)
            self.send_header("content-type", e.headers.get("content-type", "application/json"))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # upstream unreachable: report, do not hang the agent
            status = f"proxy error: {e}"
            try:
                self.send_response(502)
                self.end_headers()
            except Exception:
                pass
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"path": self.path, "status": status, "seconds": round(time.time() - t0, 1),
                                 "headers": shown, "body": body.decode("utf-8", "replace"), "response": head}) + "\n")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    if not UPSTREAM:
        sys.exit(__doc__)
    print(f"capturing to {LOG}; forwarding http://127.0.0.1:{PORT} -> {UPSTREAM}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
