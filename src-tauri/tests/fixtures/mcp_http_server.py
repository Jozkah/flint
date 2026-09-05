#!/usr/bin/env python3
"""A streamable-HTTP MCP server on loopback, for testing Jan's real transport.

Deterministic and offline. Started with a mode argument so one fixture can
produce the failure shapes the client has to survive:

    ok                 a working server
    malformed-init     initialize returns something that is not a result
    tools-list-error   initialize succeeds, tools/list fails
    tool-call-error    the tool itself reports an error
    slow-call          the tool blocks until the barrier file appears
    hang-init          accepts the connection and never answers

It binds 127.0.0.1 on a port the OS chooses and prints that port on stdout, so
the test never guesses a port and never reaches the network.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

MODE = sys.argv[1] if len(sys.argv) > 1 else "ok"
BARRIER = sys.argv[2] if len(sys.argv) > 2 else None

TOOL = {
    "name": "echo_fixture",
    "description": "Returns a fixed string, so a call can be asserted exactly.",
    "inputSchema": {"type": "object", "properties": {}},
}


def result(request_id, payload):
    return {"jsonrpc": "2.0", "id": request_id, "result": payload}


def error(request_id, message):
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32000, "message": message},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # Quiet: the test owns stdout.

    def _send(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse"}})
            return

        method = request.get("method")
        request_id = request.get("id")

        # A notification has no id and expects no body.
        if request_id is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if method == "initialize":
            if MODE == "hang-init":
                time.sleep(3600)
                return
            if MODE == "malformed-init":
                self._send({"jsonrpc": "2.0", "id": request_id, "result": {"nonsense": True}})
                return
            self._send(
                result(
                    request_id,
                    {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "jan-http-fixture", "version": "0.0.0"},
                    },
                )
            )
        elif method == "tools/list":
            if MODE == "tools-list-error":
                self._send(error(request_id, "tools are unavailable"))
                return
            self._send(result(request_id, {"tools": [TOOL]}))
        elif method == "tools/call":
            if MODE == "tool-call-error":
                self._send(error(request_id, "the tool refused"))
                return
            if MODE == "slow-call" and BARRIER:
                # Blocks until the test releases it, so "in flight" is a state
                # the test controls rather than a race it hopes for.
                while not os.path.exists(BARRIER):
                    time.sleep(0.02)
            self._send(
                result(
                    request_id,
                    {"content": [{"type": "text", "text": "fixture-answer"}], "isError": False},
                )
            )
        else:
            self._send(error(request_id, "method not found"))


server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
