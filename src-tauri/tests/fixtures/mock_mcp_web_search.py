#!/usr/bin/env python3
"""A stdio MCP server exposing one tool named ``web_search``, for cowork-smoke.

janhq/jan#8777: a call named ``web_search`` used to be taken for Jan's own
built-in web tool by name alone, auto-approved and sent to the native adapter
-- even when it came from an MCP server and built-in search was off. This
server exists so the harness can make exactly that call and watch the app ask
for approval and run it here.

No network. Every call is appended to the file named by ``--log`` (one JSON
line), so the harness can tell a call that reached this server from one that
went anywhere else.
"""

from __future__ import annotations

import argparse
import json
import sys

RESULT_MARKER = "SMOKE-MCP-WEB-SEARCH-RESULT"


def reply(message_id, result=None, error=None):
    payload = {"jsonrpc": "2.0", "id": message_id}
    if error is not None:
        payload["error"] = error
    else:
        payload["result"] = result
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    # Optional: every method received, one JSON line each, so the harness can
    # see which requests the app sends (AH-139 liveness), and this process's
    # id, so the harness can stop exactly this server and nothing else.
    parser.add_argument("--methods")
    parser.add_argument("--pid")
    args = parser.parse_args()

    if args.pid:
        import os

        with open(args.pid, "w", encoding="utf-8") as pid_file:
            pid_file.write(str(os.getpid()))

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = message.get("method")
        message_id = message.get("id")
        if args.methods:
            import time

            with open(args.methods, "a", encoding="utf-8") as seen:
                seen.write(json.dumps({"method": method, "at": time.time()}) + "\n")
        if message_id is None:
            # A notification (`notifications/initialized` and the like).
            continue
        if method == "initialize":
            requested = (message.get("params") or {}).get("protocolVersion")
            reply(
                message_id,
                {
                    "protocolVersion": requested or "2025-03-26",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "smoke-web-search", "version": "1.0.0"},
                },
            )
        elif method == "tools/list":
            reply(
                message_id,
                {
                    "tools": [
                        {
                            "name": "web_search",
                            "description": "Search the web (smoke fixture; returns a fixed marker).",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"query": {"type": "string"}},
                                "required": ["query"],
                            },
                        }
                    ]
                },
            )
        elif method == "tools/call":
            params = message.get("params") or {}
            with open(args.log, "a", encoding="utf-8") as log:
                log.write(json.dumps(params) + "\n")
            reply(
                message_id,
                {"content": [{"type": "text", "text": RESULT_MARKER}], "isError": False},
            )
        elif method == "ping":
            reply(message_id, {})
        else:
            reply(message_id, error={"code": -32601, "message": f"no method {method}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
