#!/usr/bin/env python3
"""A local HTTPS server signed by a throwaway test certificate authority, for
testing custom CA bundles (AH-190).

`--make-ca DIR` writes, into DIR, a test CA (`ca.pem`), a server certificate
for `localhost` and `127.0.0.1` signed by it (`server.pem`, `server.key`), a
certificate signed by the same CA for a *different* host (`other.pem`,
`other.key`), and a bundle file holding only unrelated junk (`junk.pem`). Keys
are generated fresh each time with the `cryptography` package already
installed; nothing is fetched, and nothing is added to any system store.

`--serve DIR --mode MODE` serves one OpenAI-style endpoint
(`GET /v1/models`, `POST /v1/chat/completions`) and logs every request line to
`--log` as JSON:

* `valid`      -- HTTPS with the localhost certificate.
* `wrong-host` -- HTTPS with the certificate for another host.
* `plain`      -- plain HTTP on the port, to prove a client that expected TLS
                  never falls back to sending its request in the clear.

Prints `PORT <n>` on stdout.
"""
import argparse
import datetime
import ipaddress
import json
import os
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ARGS = argparse.Namespace()
LOCK = threading.Lock()


def make_ca(directory):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    os.makedirs(directory, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)

    def key():
        return ec.generate_private_key(ec.SECP256R1())

    def write_key(path, k):
        with open(path, "wb") as f:
            f.write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))

    def write_cert(path, c):
        with open(path, "wb") as f:
            f.write(c.public_bytes(serialization.Encoding.PEM))

    ca_key = key()
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Jan AH-190 Test CA (throwaway)")])
    ca = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=2))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False,
                                     key_encipherment=False, data_encipherment=False, key_agreement=False,
                                     encipher_only=False, decipher_only=False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    write_cert(os.path.join(directory, "ca.pem"), ca)

    def leaf(common_name, names, ips, stem):
        k = key()
        sans = [x509.DNSName(n) for n in names] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
        cert = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)]))
            .issuer_name(ca_name)
            .public_key(k.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        write_cert(os.path.join(directory, f"{stem}.pem"), cert)
        write_key(os.path.join(directory, f"{stem}.key"), k)

    leaf("localhost", ["localhost"], ["127.0.0.1"], "server")
    leaf("other.invalid", ["other.invalid"], [], "other")
    with open(os.path.join(directory, "junk.pem"), "w") as f:
        f.write("-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n")
    print(json.dumps({"dir": directory, "files": sorted(os.listdir(directory))}))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _log(self):
        if ARGS.log:
            with LOCK, open(ARGS.log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"at": time.time(), "method": self.command, "path": self.path, "mode": ARGS.mode}) + "\n")

    def _json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._log()
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "tls-model", "object": "model"}]})
        return self._json(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        self._log()
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": "not_found"})
        try:
            stream = bool(json.loads(raw or b"{}").get("stream"))
        except json.JSONDecodeError:
            stream = False
        if not stream:
            return self._json(200, {
                "id": "chatcmpl-tls", "object": "chat.completion", "model": "tls-model",
                "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "reached over TLS"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 3, "total_tokens": 4},
            })
        # A streaming client is answered the way a provider answers it: server-sent
        # events, one delta at a time, then [DONE].
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def event(payload):
            self.wfile.write(b"data: " + json.dumps(payload).encode() + b"\n\n")
            self.wfile.flush()

        base = {"id": "chatcmpl-tls", "object": "chat.completion.chunk", "model": "tls-model"}
        event(dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]))
        for word in ["reached ", "over ", "TLS"]:
            event(dict(base, choices=[{"index": 0, "delta": {"content": word}, "finish_reason": None}]))
        event(dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                   usage={"prompt_tokens": 1, "completion_tokens": 3, "total_tokens": 4}))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


def serve(directory):
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    if ARGS.mode in ("valid", "wrong-host"):
        stem = "server" if ARGS.mode == "valid" else "other"
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(os.path.join(directory, f"{stem}.pem"), os.path.join(directory, f"{stem}.key"))
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"PORT {server.server_address[1]}", flush=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--make-ca")
    parser.add_argument("--serve")
    parser.add_argument("--mode", choices=["valid", "wrong-host", "plain"], default="valid")
    parser.add_argument("--log")
    parser.parse_args(namespace=ARGS)
    if ARGS.make_ca:
        make_ca(ARGS.make_ca)
        return 0
    if ARGS.serve:
        serve(ARGS.serve)
        return 0
    parser.error("one of --make-ca or --serve is required")


if __name__ == "__main__":
    sys.exit(main())
