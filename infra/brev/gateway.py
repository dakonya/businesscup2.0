#!/usr/bin/env python3
"""Small authenticated, bounded gateway for a loopback-only vLLM server."""
from __future__ import annotations

import hmac
import http.client
import json
import os
import re
import socket
import threading
import time
from collections import deque
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "nvidia/NVIDIA-Nemotron-Nano-9B-v2"
MAX_REQUEST = 65_536
MAX_RESPONSE = 65_536
UPSTREAM_TIMEOUT = 20
ALLOWED_FIELDS = {"model", "messages", "stream", "max_tokens", "temperature", "top_p", "response_format", "stop", "seed"}


@dataclass(frozen=True)
class Config:
    token: str
    upstream_port: int = 8000
    port: int = 9000

    @classmethod
    def from_env(cls) -> "Config":
        token = os.environ.get("COACH_GATEWAY_TOKEN", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
            raise ValueError("COACH_GATEWAY_TOKEN must contain 32-128 letters, digits, underscores or hyphens")
        return cls(token)


class Gateway(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 8

    def __init__(self, config: Config):
        self.config = config
        self.inflight = threading.BoundedSemaphore(1)
        self.connections = threading.BoundedSemaphore(8)
        self.rate_lock = threading.Lock()
        self.rate_window: deque[float] = deque()
        super().__init__(("127.0.0.1", config.port), Handler)

    def process_request(self, request: socket.socket, client_address: tuple) -> None:
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()

    def allow_request(self) -> bool:
        with self.rate_lock:
            now = time.monotonic()
            while self.rate_window and self.rate_window[0] <= now - 60:
                self.rate_window.popleft()
            if len(self.rate_window) >= 20:
                return False
            self.rate_window.append(now)
            return True

    def handle_error(self, request: socket.socket, client_address: tuple) -> None:
        # Do not emit request data, headers, stack traces or credentials.
        pass


class Handler(BaseHTTPRequestHandler):
    server: Gateway
    protocol_version = "HTTP/1.1"
    server_version = "IncidentLabGateway"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format: str, *args: object) -> None:
        pass

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        self.reply(code, {"error": "request_rejected"})

    def reply(self, status: int, body: dict | bytes) -> None:
        data = body if isinstance(body, bytes) else json.dumps(body, separators=(",", ":")).encode()
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, {"status": "ok", "service": "incidentlab-gateway"})
        else:
            self.reply(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.reply(404, {"error": "not_found"})
            return
        authorization = self.headers.get_all("Authorization", [])
        expected = "Bearer " + self.server.config.token
        if len(authorization) != 1 or not hmac.compare_digest(authorization[0].encode(), expected.encode()):
            self.reply(401, {"error": "unauthorized"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1:
            self.reply(400, {"error": "content_length_required"})
            return
        try:
            length = int(lengths[0])
        except ValueError:
            length = -1
        if length <= 0 or length > MAX_REQUEST:
            self.reply(413, {"error": "request_too_large"})
            return
        if self.headers.get_content_type() != "application/json":
            self.reply(415, {"error": "json_required"})
            return
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError()
            payload = json.loads(raw)
            self.validate(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError, socket.timeout):
            self.reply(400, {"error": "invalid_request"})
            return
        if not self.server.allow_request():
            self.reply(429, {"error": "rate_limited"})
            return
        if not self.server.inflight.acquire(blocking=False):
            self.reply(429, {"error": "inference_busy"})
            return
        try:
            self.forward(raw)
        finally:
            self.server.inflight.release()

    @staticmethod
    def validate(body: object) -> None:
        if not isinstance(body, dict) or set(body) - ALLOWED_FIELDS or body.get("model") != MODEL:
            raise ValueError()
        if body.get("stream", False) is not False:
            raise ValueError()
        maximum = body.get("max_tokens")
        if isinstance(maximum, bool) or not isinstance(maximum, int) or not 1 <= maximum <= 800:
            raise ValueError()
        messages = body.get("messages")
        if not isinstance(messages, list) or not 1 <= len(messages) <= 16:
            raise ValueError()
        for message in messages:
            if not isinstance(message, dict) or set(message) != {"role", "content"}:
                raise ValueError()
            if message["role"] not in ("system", "user", "assistant") or not isinstance(message["content"], str):
                raise ValueError()
        for key in ("temperature", "top_p"):
            if key in body and (isinstance(body[key], bool) or not isinstance(body[key], (int, float)) or not 0 <= body[key] <= 1):
                raise ValueError()

    def forward(self, raw: bytes) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.server.config.upstream_port, timeout=UPSTREAM_TIMEOUT)
        deadline = time.monotonic() + UPSTREAM_TIMEOUT
        try:
            connection.request("POST", "/v1/chat/completions", raw, {"Content-Type": "application/json", "Accept": "application/json"})
            upstream_socket = connection.sock
            response = connection.getresponse()
            if response.status != 200 or response.headers.get_content_type() != "application/json":
                self.reply(502, {"error": "inference_unavailable"})
                return
            pieces: list[bytes] = []
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                if upstream_socket:
                    upstream_socket.settimeout(remaining)
                piece = response.read(min(8192, MAX_RESPONSE + 1 - size))
                if not piece:
                    break
                size += len(piece)
                if size > MAX_RESPONSE:
                    self.reply(502, {"error": "inference_response_too_large"})
                    return
                pieces.append(piece)
                if response.isclosed():
                    break
            result = b"".join(pieces)
            json.loads(result)
            self.reply(200, result)
        except (OSError, TimeoutError, http.client.HTTPException, ValueError):
            self.reply(502, {"error": "inference_unavailable"})
        finally:
            connection.close()


if __name__ == "__main__":
    try:
        gateway = Gateway(Config.from_env())
    except ValueError as error:
        raise SystemExit(str(error)) from None
    print("IncidentLab gateway listening on loopback:9000", flush=True)
    gateway.serve_forever(poll_interval=0.5)
