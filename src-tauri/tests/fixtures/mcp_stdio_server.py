#!/usr/bin/env python3
"""A minimal MCP server over stdio, for testing Jan's real launch path.

Deterministic on purpose: one tool, one answer. It exists so the handshake,
the tool listing and the tool call are real rather than simulated, without
reaching a network or depending on anything installed.
"""
import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


TOOL = {
    "name": "echo_fixture",
    "description": "Returns a fixed string, so a call can be asserted exactly.",
    "inputSchema": {"type": "object", "properties": {}},
}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except json.JSONDecodeError:
        continue

    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        continue

    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "jan-test-fixture", "version": "0.0.0"},
            },
        })
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": [TOOL]}})
    elif method == "tools/call":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "content": [{"type": "text", "text": "fixture-answer"}],
                "isError": False,
            },
        })
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "method not found"},
        })
