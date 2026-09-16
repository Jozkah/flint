#!/usr/bin/env python3
"""A minimal OAuth 2.0 authorization server with an MCP endpoint behind it, for
testing MCP token refresh, storage and scopes.

Serves RFC 8414 metadata at /.well-known/oauth-authorization-server, dynamic
client registration at /register, an authorization endpoint at /authorize that
consents on its own and redirects straight back to the client's redirect uri
(no browser and no person involved -- a test fetches the consent url), a token
endpoint that answers `grant_type=authorization_code` and
`grant_type=refresh_token`, and a streamable-HTTP MCP endpoint at /mcp that
only answers a request carrying a bearer token this server issued (or the one
named by --initial-access).

Scopes: /authorize remembers the scopes the client asked for with its code.
The code exchange grants exactly those, unless --grant-extra-scope adds one the
client never asked for (a provider widening a grant) or --grant-only narrows
the grant to the listed scopes. A refresh returns no `scope` unless
--refresh-scope names what to claim. The response's `scope` is omitted when
--omit-granted-scope is given (RFC 6749 section 5.1: then it is the scope that
was requested).

Every exchange, refresh and MCP request is logged to the file named by --log as
one JSON line -- tokens recorded only as a short fingerprint -- so a test can
assert what was asked for, what was granted and which token each MCP request
carried. A refresh with an unknown refresh token is refused, and an MCP request
with an unknown or missing bearer gets 401.

Prints `PORT <n>` on stdout.
"""
import argparse
import hashlib
import json
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = argparse.Namespace()
ISSUED = {"count": 0}
VALID = set()
CODES = {}
LOCK = threading.Lock()


def fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()[:12] if token else ""


def log(entry):
    if not ARGS.log:
        return
    with LOCK, open(ARGS.log, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, status, body, headers=None):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _html(self, status, body):
        # A single-page-app catch-all: 200 + HTML at a metadata URL. rmcp 0.8.5
        # treated this as a fatal parse error and aborted discovery; rmcp 3.x
        # skips the unparseable candidate and falls through to
        # protected-resource discovery. Modelled by --spa-catch-all.
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        base = f"http://127.0.0.1:{self.server.server_address[1]}"
        prefix = "/.well-known/oauth-authorization-server"
        if self.path.startswith(prefix):
            # RFC 8414 path-aware discovery: for an issuer with a path
            # (e.g. `{base}/mcp`), the metadata lives at
            # `/.well-known/oauth-authorization-server/mcp` and its `issuer`
            # MUST equal that issuer. rmcp 3.x enforces this, so echo the
            # requested suffix rather than always returning the origin.
            suffix = urllib.parse.urlparse(self.path).path[len(prefix):]
            # SPA catch-all: every authorization-server metadata URL except the
            # dedicated `/authsrv` one serves HTML, forcing discovery to fall
            # through to the protected-resource path.
            if ARGS.spa_catch_all and suffix != "/authsrv":
                return self._html(200, "<!doctype html><html><body>app</body></html>")
            issuer = base + suffix
            return self._json(200, {
                "issuer": issuer,
                "authorization_endpoint": f"{base}/authorize",
                "token_endpoint": f"{base}/token",
                "registration_endpoint": f"{base}/register",
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
                "code_challenge_methods_supported": ["S256"],
            })
        if self.path.startswith("/.well-known/oauth-protected-resource"):
            # RFC 9728 protected-resource metadata. Under --spa-catch-all the
            # authorization server is advertised at `{base}/authsrv`, whose
            # metadata (above) is the only JSON one; otherwise it is the
            # resource itself.
            authsrv = f"{base}/authsrv" if ARGS.spa_catch_all else f"{base}/mcp"
            return self._json(200, {
                "resource": f"{base}/mcp",
                "authorization_servers": [authsrv],
            })
        if self.path.startswith("/authorize"):
            return self._authorize()
        if self.path.startswith("/mcp"):
            # No server-initiated stream.
            self.send_response(405)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        return self._json(404, {"error": "not_found"})

    def do_DELETE(self):
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _authorize(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        redirect = query.get("redirect_uri", [""])[0]
        state = query.get("state", [""])[0]
        scope = query.get("scope", [""])[0]
        with LOCK:
            ISSUED["count"] += 1
            code = f"code-{ISSUED['count']}"
            CODES[code] = scope
        log({"at": time.time(), "path": "/authorize", "requested_scope": scope,
             "client_id": query.get("client_id", [""])[0]})
        if not redirect:
            return self._json(400, {"error": "invalid_request"})
        target = redirect + ("&" if "?" in redirect else "?") + urllib.parse.urlencode({"code": code, "state": state})
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.path.startswith("/mcp"):
            return self._mcp(raw)
        if self.path.startswith("/register"):
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                body = {}
            return self._json(201, {
                "client_id": "fixture-client",
                "client_name": body.get("client_name", ""),
                "redirect_uris": body.get("redirect_uris", []),
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            })
        if self.path != "/token":
            return self._json(404, {"error": "not_found"})
        form = urllib.parse.parse_qs(raw.decode())
        grant = form.get("grant_type", [""])[0]
        if grant == "authorization_code":
            return self._exchange(form)
        refresh = form.get("refresh_token", [""])[0]
        entry = {"at": time.time(), "path": "/token", "grant": grant, "refresh_token": refresh}
        if grant != "refresh_token" or refresh != ARGS.accept:
            entry["outcome"] = "refused"
            log(entry)
            return self._json(400, {"error": "invalid_grant"})
        with LOCK:
            ISSUED["count"] += 1
            token = f"refreshed-access-{ISSUED['count']}"
            VALID.add(token)
        entry["outcome"] = "issued"
        entry["issued"] = fingerprint(token)
        body = {
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": ARGS.expires_in,
        }
        if ARGS.refresh_scope:
            body["scope"] = ARGS.refresh_scope
            entry["granted_scope"] = ARGS.refresh_scope
        log(entry)
        # RFC 6749 section 6: a provider may keep the refresh token it issued
        # and not send it again.
        if not ARGS.omit_refresh:
            body["refresh_token"] = ARGS.accept
        return self._json(200, body)

    def _exchange(self, form):
        code = form.get("code", [""])[0]
        with LOCK:
            requested = CODES.pop(code, None)
        entry = {"at": time.time(), "path": "/token", "grant": "authorization_code"}
        if requested is None:
            entry["outcome"] = "refused"
            log(entry)
            return self._json(400, {"error": "invalid_grant"})
        granted = [s for s in requested.split(" ") if s]
        if ARGS.grant_only is not None:
            granted = [s for s in ARGS.grant_only.split(" ") if s]
        if ARGS.grant_extra_scope:
            granted.append(ARGS.grant_extra_scope)
        with LOCK:
            ISSUED["count"] += 1
            token = f"code-access-{ISSUED['count']}"
            VALID.add(token)
        entry.update({"outcome": "issued", "issued": fingerprint(token),
                      "requested_scope": requested, "granted_scope": " ".join(granted)})
        log(entry)
        body = {
            "access_token": token,
            "token_type": "Bearer",
            "expires_in": ARGS.expires_in,
            "refresh_token": ARGS.accept,
        }
        if not ARGS.omit_granted_scope:
            body["scope"] = " ".join(granted)
        return self._json(200, body)

    def _mcp(self, raw):
        header = self.headers.get("Authorization", "")
        bearer = header[7:] if header.lower().startswith("bearer ") else ""
        try:
            request = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            request = {}
        method = request.get("method")
        allowed = bearer != "" and (bearer in VALID or bearer == ARGS.initial_access)
        log({
            "at": time.time(),
            "path": "/mcp",
            "method": method,
            "bearer": fingerprint(bearer),
            "outcome": "answered" if allowed else "unauthorized",
        })
        if not allowed:
            base = f"http://127.0.0.1:{self.server.server_address[1]}"
            return self._json(401, {"error": "invalid_token"}, {
                "WWW-Authenticate": f'Bearer error="invalid_token", resource_metadata="{base}/.well-known/oauth-protected-resource"',
            })
        request_id = request.get("id")
        if request_id is None:
            self.send_response(202)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if method == "initialize":
            body = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}, "prompts": {}},
                "serverInfo": {"name": "jan-oauth-fixture", "version": "0.0.0"},
            }
        elif method == "tools/list":
            body = {"tools": [{
                "name": "whoami",
                "description": "Says the request was authorized.",
                "inputSchema": {"type": "object", "properties": {}},
            }]}
        elif method == "prompts/list":
            body = {"prompts": [{"name": "authorized", "description": "Only listed to an authorized client."}]}
        elif method == "tools/call":
            body = {"content": [{"type": "text", "text": "authorized"}], "isError": False}
        else:
            return self._json(200, {"jsonrpc": "2.0", "id": request_id,
                                    "error": {"code": -32601, "message": "method not found"}})
        return self._json(200, {"jsonrpc": "2.0", "id": request_id, "result": body})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log")
    parser.add_argument("--accept", default="good-refresh-token")
    parser.add_argument("--initial-access", default="")
    parser.add_argument("--expires-in", type=int, default=3600)
    parser.add_argument("--omit-refresh", action="store_true")
    parser.add_argument("--grant-extra-scope", default="")
    parser.add_argument("--grant-only", default=None)
    parser.add_argument("--refresh-scope", default="")
    parser.add_argument("--omit-granted-scope", action="store_true")
    parser.add_argument("--spa-catch-all", action="store_true")
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
