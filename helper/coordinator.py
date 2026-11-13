"""Share course ownership between local browser profiles."""

import argparse
from contextlib import closing
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import secrets
import sqlite3


class QueueHandler(BaseHTTPRequestHandler):
    timeout = 4

    def log_message(self, *_):
        pass

    def reply(self, code, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        host, port = self.server.server_address
        auth = self.headers.get("Authorization", "")
        if self.headers.get("Host") != f"{host}:{port}" or not secrets.compare_digest(
            auth.encode("utf-8"), b"Bearer " + self.server.key.encode("ascii")
        ):
            return self.reply(403, {"error": "invalid_key"})
        if self.path == "/check":
            return self.reply(200, {"status": "ready"})
        if self.path not in ("/claim", "/finish"):
            return self.reply(404, {"error": "unknown_action"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024 or self.headers.get_content_type() != "application/json":
                raise ValueError
            data = json.loads(self.rfile.read(size))
            slug, worker = data["slug"], data["worker"]
            if not re.fullmatch(r"[a-z0-9-]{1,200}", slug) or not re.fullmatch(r"[a-f0-9-]{36}", worker):
                raise ValueError
        except (TypeError, KeyError, ValueError, TimeoutError):
            return self.reply(400, {"error": "invalid_request"})

        db = self.server.db
        with db:
            if self.path == "/claim":
                db.execute("INSERT OR IGNORE INTO courses (slug, worker) VALUES (?, ?)", (slug, worker))
            row = db.execute("SELECT worker, done FROM courses WHERE slug = ?", (slug,)).fetchone()
            if self.path == "/finish" and (not row or row[0] != worker):
                return self.reply(409, {"error": "not_owner"})
            if self.path == "/finish":
                db.execute("UPDATE courses SET done = 1 WHERE slug = ?", (slug,))
                status = "done"
            elif row[0] == worker:
                status = "own_done" if row[1] else "owned"
            else:
                status = "done" if row[1] else "busy"
        self.reply(200, {"status": status})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch", default="default")
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parent.parent / ".parallel")
    parser.add_argument("--port", type=int, default=8716)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9-]{1,48}", args.batch):
        parser.error("Use lowercase letters, digits and hyphens in the batch name.")
    args.data_dir.mkdir(parents=True, exist_ok=True)
    with HTTPServer(("127.0.0.1", args.port), QueueHandler) as server, closing(
        sqlite3.connect(args.data_dir / (args.batch + ".sqlite3"))
    ) as db:
        with db:
            db.execute("CREATE TABLE IF NOT EXISTS batch (key TEXT NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS courses (
                slug TEXT PRIMARY KEY, worker TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
            )""")
            row = db.execute("SELECT key FROM batch").fetchone()
            key = row[0] if row else secrets.token_hex(16)
            if not row:
                db.execute("INSERT INTO batch (key) VALUES (?)", (key,))
        server.db = db
        server.key = key
        print(f"Queue on 127.0.0.1:{server.server_port} | batch: {args.batch} | key: {key}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
