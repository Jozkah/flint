#!/usr/bin/env python3
"""An SSE MCP server on loopback, for testing Jan's real SSE transport.

The SSE transport is two halves: a long-lived GET that streams
server-to-client events, and a POST endpoint the client is told about in the
first `endpoint` event. Both are implemented here so the handshake is the real
one rather than a shape that merely resembles it.

Modes, so the failure paths are reachable:

    ok                 a working server
    malformed-event    the stream carries an event that is not valid JSON-RPC
    close-during-init  the stream closes after the endpoint, before initialize
    tools-list-error   initialize succeeds, tools/list fails
    slow-call          the tool blocks until a barrier file appears

Binds 127.0.0.1 on an OS-chosen port and prints it on stdout.
"""
import json
import os
import queue
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else "ok"
BARRIER = sys.argv[2] if len(sys.argv) > 2 else None

TOOL = {
    "name": "echo_fixture",
    "description": "Returns a fixed string, so a call can be asserted exactly.",
    "inputSchema": {"type": "object", "properties": {}},
}

# Responses the POST handler produces are handed to the open SSE stream.
outbound: "queue.Queue[str | None]" = queue.Queue()


def result(request_id, payload):
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def error(request_id, message):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": message},
    }


def handle(request):
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        return None  # A notification expects no reply.

    if method == "initialize":
        return result(
            request_id,
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "jan-sse-fixture", "version": "0.0.0"},
            },
        )
    if method == "tools/list":
        if MODE == "tools-list-error":
            return error(request_id, "tools are unavailable")
        return result(request_id, {"tools": [TOOL]})
    if method == "tools/call":
        if MODE == "slow-call" and BARRIER:
            while not os.path.exists(BARRIER):
                threading.Event().wait(0.02)
        return result(
            request_id,
            {"content": [{"type": "text", "text": "fixture-answer"}], "isError": False},
        )
    return error(request_id, "method not found")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        # The event stream. The first event names the endpoint the client
        # posts to, which is how the SSE transport learns where to write.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"event: endpoint\ndata: /messages\n\n")
        self.wfile.flush()

        if MODE == "close-during-init":
            return  # Drop the stream before the handshake can finish.

        if MODE == "malformed-event":
            self.wfile.write(b"event: message\ndata: not-json\n\n")
            self.wfile.flush()

        while True:
            payload = outbound.get()
            if payload is None:
                return
            try:
                self.wfile.write(f"event: message\ndata: {payload}\n\n".encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) or b"{}"
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            return
        reply = handle(request)
        if reply is not None:
            outbound.put(json.dumps(reply))


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
server.daemon_threads = True
print(server.server_address[1], flush=True)
server.serve_forever()
