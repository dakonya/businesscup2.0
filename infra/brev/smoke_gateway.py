#!/usr/bin/env python3
"""Real direct inference probe; prints only status and success booleans."""
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

MODEL = "nvidia/NVIDIA-Nemotron-Nano-9B-v2"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def main() -> int:
    token = os.environ.get("COACH_GATEWAY_TOKEN", "")
    if not token:
        # Do not source the file or evaluate shell code.
        path = Path(__file__).with_name(".env")
        if path.exists():
            if stat.S_IMODE(path.stat().st_mode) != 0o600:
                print("Gateway credential file must have permissions 0600.")
                return 2
            for line in path.read_text().splitlines():
                if line.startswith("COACH_GATEWAY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip("\"'")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        print("Gateway credential is missing or has an invalid format.")
        return 2
    url = os.environ.get("BREV_GATEWAY_URL", "http://127.0.0.1:9000").rstrip("/")
    parsed = urlsplit(url)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        print("Gateway URL must be an origin without credentials, query or path.")
        return 2
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")):
        print("Use HTTPS for external requests.")
        return 2
    schema = {"type": "object", "properties": {"ok": {"type": "boolean", "enum": [True]}}, "required": ["ok"], "additionalProperties": False}
    payload = {"model": MODEL, "messages": [{"role": "system", "content": "/no_think\nReturn JSON matching the schema."}, {"role": "user", "content": "Return an object whose ok field is true."}], "stream": False, "temperature": 0, "max_tokens": 256, "response_format": {"type": "json_schema", "json_schema": {"name": "probe", "strict": True, "schema": schema}}}
    request = urllib.request.Request(url + "/v1/chat/completions", json.dumps(payload).encode(), {"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError()
            envelope = json.loads(raw)
            content = json.loads(envelope["choices"][0]["message"]["content"])
            success = isinstance(content, dict) and set(content) == {"ok"} and content["ok"] is True
            print(json.dumps({"httpStatus": response.status, "realInference": True, "validProbeJson": success}))
            return 0 if success else 1
    except urllib.error.HTTPError as error:
        print(json.dumps({"httpStatus": error.code, "realInference": False}))
        return 1
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        print("Inference probe failed; no credentials or response body were printed.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
