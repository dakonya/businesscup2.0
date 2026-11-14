#!/usr/bin/env python3
"""Gateway boundary tests. The upstream is a test double, never model inference."""
import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from gateway import Config, Gateway, MAX_RESPONSE, MODEL

TOKEN = "test-only-token-" + "x" * 40


class ConfigTests(unittest.TestCase):
    def test_missing_weak_or_shell_sensitive_token_is_rejected(self):
        for token in ("", "short", "x" * 129, "$" + "x" * 40, "x" * 40 + "\n"):
            with patch.dict("os.environ", {"COACH_GATEWAY_TOKEN": token}, clear=True):
                with self.assertRaises(ValueError):
                    Config.from_env()

    def test_urlsafe_token_is_accepted(self):
        with patch.dict("os.environ", {"COACH_GATEWAY_TOKEN": TOKEN}, clear=True):
            self.assertEqual(Config.from_env().token, TOKEN)


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.calls.append((self.path, self.headers.get("Authorization"), json.loads(data)))
        self.server.entered.set()
        self.server.release.wait(3)
        if self.server.large:
            body = b"x" * (MAX_RESPONSE + 1)
        elif self.server.invalid:
            body = b"not-json"
        else:
            body = b'{"choices":[{"message":{"content":"test-double-response"}}]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        self.upstream.calls = []
        self.upstream.large = False
        self.upstream.invalid = False
        self.upstream.entered = threading.Event()
        self.upstream.release = threading.Event()
        self.upstream.release.set()
        self.gateway = Gateway(Config(TOKEN, upstream_port=self.upstream.server_port, port=0))
        self.threads = []
        for server in (self.upstream, self.gateway):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.threads.append(thread)

    def tearDown(self):
        self.upstream.release.set()
        for server in (self.gateway, self.upstream):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(2)

    def request(self, path="/v1/chat/completions", method="POST", token=TOKEN, payload=None, headers=None):
        if payload is None:
            payload = {"model": MODEL, "messages": [{"role": "system", "content": "/no_think"}, {"role": "user", "content": "test"}], "max_tokens": 32, "stream": False}
        raw = json.dumps(payload).encode() if not isinstance(payload, bytes) else payload
        request_headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.gateway.server_port, timeout=5)
        connection.request(method, path, raw if method == "POST" else None, request_headers)
        response = connection.getresponse()
        result = (response.status, json.loads(response.read()))
        connection.close()
        return result

    def test_authorized_request_only_forwards_json_to_fixed_upstream(self):
        status, response = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(response["choices"][0]["message"]["content"], "test-double-response")
        self.assertEqual(len(self.upstream.calls), 1)
        self.assertEqual(self.upstream.calls[0][0], "/v1/chat/completions")
        self.assertIsNone(self.upstream.calls[0][1])

    def test_wrong_token_never_reaches_model(self):
        self.assertEqual(self.request(token="wrong")[0], 401)
        self.assertEqual(self.upstream.calls, [])

    def test_raw_vllm_paths_and_query_strings_are_not_exposed(self):
        for path in ("/invocations", "/docs", "/v1/models", "/v1/chat/completions?model=other"):
            self.assertEqual(self.request(path)[0], 404)
        self.assertEqual(self.upstream.calls, [])

    def test_body_and_model_limits_never_reach_model(self):
        self.assertEqual(self.request(payload=b"x" * 65537)[0], 413)
        self.assertEqual(self.request(payload=b"not json")[0], 400)
        for fields in ({"model": "other"}, {"max_tokens": 801}, {"stream": True}, {"ignore_eos": True}):
            base = {"model": MODEL, "messages": [{"role": "user", "content": "test"}], "max_tokens": 32}
            base.update(fields)
            self.assertEqual(self.request(payload=base)[0], 400)
        self.assertEqual(self.upstream.calls, [])

    def test_content_type_is_required(self):
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.upstream.calls, [])

    def test_only_one_model_request_is_inflight(self):
        self.upstream.release.clear()
        first = []
        thread = threading.Thread(target=lambda: first.append(self.request()))
        thread.start()
        self.assertTrue(self.upstream.entered.wait(2))
        self.assertEqual(self.request()[0], 429)
        self.upstream.release.set()
        thread.join(4)
        self.assertEqual(first[0][0], 200)
        self.assertEqual(len(self.upstream.calls), 1)

    def test_oversized_or_invalid_upstream_is_not_relayed(self):
        self.upstream.large = True
        self.assertEqual(self.request()[0], 502)
        self.upstream.large = False
        self.upstream.invalid = True
        self.assertEqual(self.request()[0], 502)

    def test_gateway_health_does_not_claim_model_ready(self):
        status, response = self.request("/health", "GET")
        self.assertEqual(status, 200)
        self.assertEqual(response, {"status": "ok", "service": "incidentlab-gateway"})
        self.assertEqual(self.upstream.calls, [])

    def test_rate_window_rejects_before_inference(self):
        self.gateway.rate_window.extend([__import__("time").monotonic()] * 20)
        self.assertEqual(self.request()[0], 429)
        self.assertEqual(self.upstream.calls, [])


if __name__ == "__main__":
    unittest.main()
