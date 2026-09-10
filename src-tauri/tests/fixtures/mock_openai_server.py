#!/usr/bin/env python3
"""Deterministic OpenAI-compatible server for the cowork-smoke harness.

The Cowork run talks to a model over the OpenAI chat-completions API, so
nothing downstream of it -- the activity timeline, tool calls, permission
prompts, background tasks -- can be exercised without one. This stands in for
it: no network, no weights, and the same answer every time.

Prints the port it bound on stdout as ``PORT <n>`` so the harness does not have
to guess one.

Scripting
---------
The reply is chosen by ``--script``:

``plain``
    One short assistant message, streamed.
``tools``
    A ``tool_calls`` delta naming the tools listed by ``--tools`` (in order),
    then, on the follow-up request that carries the tool results, a short
    summary. This is what produces reads, edits, bash and test rows in the
    activity timeline.
``fail``
    Streams a little, then ends the stream mid-flight, so the run has to
    surface a failure.
``slow``
    Streams a token every ``--delay`` seconds forever, so a cancellation has
    something to cancel.
``proxy-403``
    Every route answers ``403`` with ``Server: cloudflare``, reproducing a
    local-looking endpoint that is really being answered from the internet.
``no-models``
    ``/v1/models`` answers ``404``; the chat endpoint still works, which is the
    case where the UI must fall back to a manually entered model id.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = argparse.Namespace()


def sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode()


def chunk(delta: dict, finish: str | None = None) -> dict:
    return {
        "id": "chatcmpl-smoke",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": ARGS.model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Quiet: the harness reads the app's log, not this one.
    def log_message(self, *_args):
        pass

    def version_string(self) -> str:
        # BaseHTTPRequestHandler emits its own `Server:` header. In proxy mode
        # that would be the *first* one, so `headers.get("server")` would read
        # "BaseHTTP/..." and the proxy would never be recognised.
        return "cloudflare" if ARGS.script == "proxy-403" else "mock-openai"

    # -- helpers ---------------------------------------------------------
    def _json(self, status: int, body: dict, extra_headers: dict | None = None):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def _forbidden(self):
        raw = b"error code: 1003"
        self.send_response(403)
        self.send_header("Content-Type", "text/plain; charset=UTF-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _begin_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # `close`, not `keep-alive`. With keep-alive and no Content-Length the
        # response is framed "until the connection closes", so a client reading
        # the body to completion waits forever after [DONE] -- which is not how
        # a real SSE endpoint behaves, and made runs look like they never
        # finished.
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    # -- routes ----------------------------------------------------------
    def do_OPTIONS(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if ARGS.script == "proxy-403":
            return self._forbidden()
        if not self.path.rstrip("/").endswith("/models"):
            return self._json(404, {"error": "not found"})
        if ARGS.script == "no-models":
            return self._json(404, {"error": "this server does not list models"})
        # Both shapes at once, exactly as llama.cpp answers.
        return self._json(
            200,
            {
                "object": "list",
                "data": [{"id": ARGS.model, "object": "model"}],
                "models": [{"name": ARGS.model, "model": ARGS.model}],
            },
        )

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        # The harness re-scripts one running server rather than starting a new
        # one per scenario, because the provider's port has to be written into
        # settings.json before the app launches.
        if self.path.rstrip("/").endswith("/__control"):
            try:
                control = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                return self._json(400, {"error": "invalid JSON"})
            for field in ("script", "tools", "reply", "summary", "delay"):
                if field in control:
                    setattr(ARGS, field, control[field])
            return self._json(200, {"script": ARGS.script, "tools": ARGS.tools})

        if ARGS.script == "proxy-403":
            return self._forbidden()
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})

        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": "not found"})

        # A request whose messages already carry tool results is the follow-up
        # turn: answer in words rather than asking for the tools again.
        carries_results = any(
            m.get("role") == "tool" for m in body.get("messages", [])
        )

        if not body.get("stream"):
            return self._json(
                200,
                {
                    "id": "chatcmpl-smoke",
                    "object": "chat.completion",
                    "created": 0,
                    "model": ARGS.model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": ARGS.reply},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )

        self._begin_stream()
        try:
            if ARGS.script == "slow":
                self.wfile.write(sse(chunk({"role": "assistant", "content": ""})))
                self.wfile.flush()
                while True:
                    self.wfile.write(sse(chunk({"content": "thinking "})))
                    self.wfile.flush()
                    time.sleep(ARGS.delay)

            if ARGS.script == "fail":
                self.wfile.write(
                    sse(chunk({"role": "assistant", "content": "starting"}))
                )
                self.wfile.flush()
                # Hang up without [DONE]: the run must report a failure.
                self.wfile.write(b'data: {"error":')
                self.wfile.flush()
                return

            # Honour `stream_options.include_usage` the way an OpenAI-compatible
            # server does: one final chunk with empty choices and the counts.
            # Jan asks for it and real servers answer; without this the mock was
            # the only provider that never reported usage, so the accounting a
            # real run produces could not be exercised at all.
            wants_usage = bool((body.get("stream_options") or {}).get("include_usage"))

            def send_usage():
                if not wants_usage:
                    return
                self.wfile.write(
                    sse(
                        {
                            "id": "chatcmpl-smoke",
                            "object": "chat.completion.chunk",
                            "created": 0,
                            "model": ARGS.model,
                            "choices": [],
                            "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
                        }
                    )
                )

            if ARGS.script == "tools" and not carries_results:
                self.wfile.write(sse(chunk({"role": "assistant", "content": ""})))
                for index, spec in enumerate(ARGS.tools):
                    name, _, raw_args = spec.partition(":")
                    self.wfile.write(
                        sse(
                            chunk(
                                {
                                    "tool_calls": [
                                        {
                                            "index": index,
                                            "id": f"call_{index}",
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": raw_args or "{}",
                                            },
                                        }
                                    ]
                                }
                            )
                        )
                    )
                self.wfile.write(sse(chunk({}, finish="tool_calls")))
                send_usage()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            text = ARGS.summary if carries_results else ARGS.reply
            self.wfile.write(sse(chunk({"role": "assistant", "content": ""})))
            for word in text.split(" "):
                self.wfile.write(sse(chunk({"content": word + " "})))
                self.wfile.flush()
            self.wfile.write(sse(chunk({}, finish="stop")))
            send_usage()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            # End the response, so the body is complete by HTTP framing.
            self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            # The client cancelled. That is a scenario, not an error.
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--model", default="smoke-model")
    parser.add_argument(
        "--script",
        default="plain",
        choices=["plain", "tools", "fail", "slow", "proxy-403", "no-models"],
    )
    parser.add_argument(
        "--tools",
        nargs="*",
        default=[],
        help="Tool calls to emit, as name:json-arguments",
    )
    parser.add_argument("--reply", default="Hello from the smoke model.")
    parser.add_argument("--summary", default="Done. I used the tools you allowed.")
    parser.add_argument("--delay", type=float, default=0.4)
    parser.parse_args(namespace=ARGS)

    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    server.daemon_threads = True
    print(f"PORT {server.server_address[1]}", flush=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
