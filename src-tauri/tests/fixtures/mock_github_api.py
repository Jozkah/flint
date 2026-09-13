#!/usr/bin/env python3
"""A local GitHub-compatible pull request API, for testing pull request creation
and description sync (AH-162, AH-163) without any real service.

Serves, for any owner/repo:

* `GET   /repos/{owner}/{repo}/pulls?head=owner:branch&state=open` -- list
* `POST  /repos/{owner}/{repo}/pulls`            -- open a pull request
* `GET   /repos/{owner}/{repo}/pulls/{number}`   -- read one
* `PATCH /repos/{owner}/{repo}/pulls/{number}`   -- change its title or body

Every request must carry `Authorization: Bearer <token>` with the token given
by `--token`; anything else is 401. Every request is logged to `--log` as one
JSON line with the method, path, status, and the token recorded only as a
fingerprint -- so a test can show which host received a credential and that
nothing else was called. Pull requests live in memory; `--state` persists them
to a JSON file so a restarted fixture keeps them.

`--redirect-to URL` answers every request with a 307 to URL instead, to show a
client does not carry its token onward. `--post-delay SECONDS` makes a create
wait before answering -- and still create the pull request -- so a client that
gives up mid-request can be shown not to open a duplicate next time.

Nothing here notifies anyone, assigns reviewers or comments: those endpoints
do not exist, and a request for one is 404.

Prints `PORT <n>` on stdout.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

ARGS = argparse.Namespace()
LOCK = threading.Lock()
PULLS = {}
NEXT = {"number": 1}


def fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()[:12] if token else ""


def load_state():
    if ARGS.state and os.path.exists(ARGS.state):
        data = json.load(open(ARGS.state, encoding="utf-8"))
        PULLS.update({int(k): v for k, v in data.get("pulls", {}).items()})
        NEXT["number"] = data.get("next", 1)


def save_state():
    if ARGS.state:
        tmp = ARGS.state + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"pulls": PULLS, "next": NEXT["number"]}, f)
        os.replace(tmp, ARGS.state)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _log(self, status):
        header = self.headers.get("Authorization", "")
        bearer = header[7:] if header.lower().startswith("bearer ") else ""
        if ARGS.log:
            with LOCK, open(ARGS.log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": time.time(), "method": self.command, "path": self.path, "status": status, "token": fingerprint(bearer)}) + "\n")

    def _reply(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self._log(status)

    def _authorized(self):
        header = self.headers.get("Authorization", "")
        return header.lower().startswith("bearer ") and header[7:] == ARGS.token

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return None

    def _route(self):
        m = re.fullmatch(r"/repos/([^/]+)/([^/]+)/pulls(?:/(\d+))?", urlsplit(self.path).path)
        if not m:
            return None
        return m.group(1), m.group(2), (int(m.group(3)) if m.group(3) else None)

    def _redirected(self):
        if ARGS.redirect_to:
            self._body()
            self._reply(307, {"message": "moved"}, {"Location": ARGS.redirect_to + self.path})
            return True
        return False

    def do_GET(self):
        if self._redirected():
            return
        route = self._route()
        if not self._authorized():
            return self._reply(401, {"message": "Bad credentials"})
        if not route:
            return self._reply(404, {"message": "Not Found"})
        repo = f"{route[0]}/{route[1]}"
        if route[2] is None:
            query = parse_qs(urlsplit(self.path).query)
            head = (query.get("head") or [""])[0]
            state = (query.get("state") or ["open"])[0]
            with LOCK:
                found = [p for p in PULLS.values() if p["repo"] == repo and p["state"] == state
                         and (not head or f"{route[0]}:{p['head']['ref']}" == head)]
            return self._reply(200, found)
        with LOCK:
            pull = PULLS.get(route[2])
        if not pull or pull["repo"] != repo:
            return self._reply(404, {"message": "Not Found"})
        return self._reply(200, pull)

    def do_POST(self):
        if self._redirected():
            return
        route = self._route()
        body = self._body()
        if not self._authorized():
            return self._reply(401, {"message": "Bad credentials"})
        if not route or route[2] is not None:
            return self._reply(404, {"message": "Not Found"})
        if not isinstance(body, dict) or not body.get("title") or not body.get("head") or not body.get("base"):
            return self._reply(422, {"message": "Validation Failed", "errors": [{"field": "title/head/base", "code": "missing_field"}]})
        with LOCK:
            number = NEXT["number"]
            NEXT["number"] += 1
            pull = {
                "number": number,
                "repo": f"{route[0]}/{route[1]}",
                "title": body["title"],
                "body": body.get("body", ""),
                "head": {"ref": body["head"], "sha": ""},
                "base": {"ref": body["base"]},
                "state": "open",
                "html_url": f"http://127.0.0.1:{self.server.server_address[1]}/{route[0]}/{route[1]}/pull/{number}",
            }
            PULLS[number] = pull
            save_state()
        if ARGS.post_delay:
            time.sleep(ARGS.post_delay)
        return self._reply(201, pull)

    def do_PATCH(self):
        if self._redirected():
            return
        route = self._route()
        body = self._body()
        if not self._authorized():
            return self._reply(401, {"message": "Bad credentials"})
        if not route or route[2] is None or not isinstance(body, dict):
            return self._reply(404, {"message": "Not Found"})
        with LOCK:
            pull = PULLS.get(route[2])
            if not pull or pull["repo"] != f"{route[0]}/{route[1]}":
                return self._reply(404, {"message": "Not Found"})
            for key in ("title", "body"):
                if key in body:
                    pull[key] = body[key]
            save_state()
        return self._reply(200, pull)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", required=True)
    parser.add_argument("--log")
    parser.add_argument("--state")
    parser.add_argument("--redirect-to", dest="redirect_to")
    parser.add_argument("--post-delay", dest="post_delay", type=float, default=0.0)
    parser.parse_args(namespace=ARGS)
    load_state()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    print(f"PORT {server.server_address[1]}", flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
