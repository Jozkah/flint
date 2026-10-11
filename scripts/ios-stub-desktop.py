"""A stand-in for a desktop's remote-access listener, for the simulator job.

Serves HTTPS with a throwaway self-signed certificate and logs every request
and every TLS connection, so the job can show that the app's pinned-TLS proxy
really reached it. Usage: ios-stub-desktop.py <port> <log-file>
"""
import http.server
import json
import pathlib
import ssl
import subprocess
import sys
import tempfile
import threading

port = int(sys.argv[1])
log = pathlib.Path(sys.argv[2])
tmp = pathlib.Path(tempfile.mkdtemp())
cert, key = tmp / "cert.pem", tmp / "key.pem"
subprocess.run(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key),
     "-out", str(cert), "-days", "1", "-subj", "/CN=127.0.0.1",
     "-addext", "subjectAltName=IP:127.0.0.1"],
    check=True, capture_output=True,
)
lock = threading.Lock()


def record(line: str) -> None:
    with lock, log.open("a") as f:
        f.write(line + "\n")


class Handler(http.server.BaseHTTPRequestHandler):
    def _reply(self):
        record(f"{self.command} {self.path} origin={self.headers.get('Origin')} host={self.headers.get('Host')}")
        body = json.dumps({"error": {"code": "unauthorized", "message": "no token"}}).encode()
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = _reply

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    def get_request(self):
        conn, addr = super().get_request()
        record(f"tls connection from {addr[0]}")
        return conn, addr


server = Server(("127.0.0.1", port), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
record(f"listening on {port}")
server.serve_forever()
