#!/usr/bin/env python3
"""A local OpenAI-compatible embeddings endpoint for testing semantic code search
(AH-071) without a real embedding model.

`POST /v1/embeddings` with `{"model", "input": str | [str]}` returns one vector
per input. The vectors are built from concept groups, not from spelling: every
word in a group adds to the same dimension, so "try again later" and
"exponential backoff" land close together although they share no word. That is
the property a test of *semantic* search needs and a lexical search cannot
fake. Words outside every group are hashed into the remaining dimensions.

Options:

* `--dim N`                vector length (default 64)
* `--unsupported`          answer 501 like a llama.cpp server started without
                           `--embeddings`
* `--delay SECONDS`        wait before answering each request
* `--wrong-dim-after N`    after N requests, answer with vectors of another
                           length, as a misconfigured server would
* `--key KEY`              require `Authorization: Bearer KEY`
* `--log FILE`             append every input text to FILE, one JSON line
                           per request, so a test can show what was sent

`GET /__stats` returns how many requests and inputs were served.
Prints `PORT <n>` on stdout.
"""
import argparse
import hashlib
import json
import math
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GROUPS = [
    {"retry", "retries", "backoff", "again", "attempt", "attempts", "exponential", "later", "resend"},
    {"password", "credential", "credentials", "login", "authenticate", "authentication", "signin", "token", "secret"},
    {"cache", "caching", "memoize", "memoized", "remember", "stale", "expiry", "ttl"},
    {"sort", "sorted", "order", "ordering", "rank", "ranking", "arrange"},
    {"parse", "parser", "parsing", "tokenize", "lexer", "grammar"},
    {"delete", "remove", "erase", "purge", "drop", "discard"},
]

ARGS = argparse.Namespace()
LOCK = threading.Lock()
STATS = {"requests": 0, "inputs": 0}


def vector(text, dim):
    v = [0.0] * dim
    for word in re.findall(r"[a-z]+", text.lower()):
        for i, group in enumerate(GROUPS):
            if word in group:
                v[i] += 1.0
                break
        else:
            h = int(hashlib.sha256(word.encode()).hexdigest(), 16)
            v[len(GROUPS) + h % (dim - len(GROUPS))] += 0.25
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path.rstrip("/") == "/__stats":
            with LOCK:
                return self._json(200, dict(STATS))
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        if not self.path.rstrip("/").endswith("/embeddings"):
            return self._json(404, {"error": "not found"})
        if ARGS.key and self.headers.get("Authorization", "") != f"Bearer {ARGS.key}":
            return self._json(401, {"error": {"message": "bad key"}})
        if ARGS.unsupported:
            return self._json(501, {"error": {"code": 501, "message": "This server does not support embeddings. Start it with `--embeddings`", "type": "not_supported_error"}})
        inputs = body.get("input")
        if isinstance(inputs, str):
            inputs = [inputs]
        if not isinstance(inputs, list) or not all(isinstance(i, str) for i in inputs):
            return self._json(400, {"error": {"message": "input must be a string or a list of strings"}})
        with LOCK:
            STATS["requests"] += 1
            STATS["inputs"] += len(inputs)
            served = STATS["requests"]
            if ARGS.log:
                with open(ARGS.log, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"at": time.time(), "inputs": inputs}) + "\n")
        if ARGS.delay:
            time.sleep(ARGS.delay)
        dim = ARGS.dim
        if ARGS.wrong_dim_after and served > ARGS.wrong_dim_after:
            dim = ARGS.dim + 3
        data = [{"object": "embedding", "index": i, "embedding": vector(text, dim)} for i, text in enumerate(inputs)]
        return self._json(200, {"object": "list", "model": body.get("model", ""), "data": data,
                                "usage": {"prompt_tokens": 0, "total_tokens": 0}})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dim", type=int, default=64)
    parser.add_argument("--unsupported", action="store_true")
    parser.add_argument("--delay", type=float, default=0.0)
    parser.add_argument("--wrong-dim-after", dest="wrong_dim_after", type=int, default=0)
    parser.add_argument("--key", default="")
    parser.add_argument("--log", default="")
    parser.parse_args(namespace=ARGS)
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
