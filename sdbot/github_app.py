"""Short-lived, repository-scoped GitHub App credentials, kept in memory only."""
from __future__ import annotations

import base64
from datetime import datetime
import json
import re
import time
import urllib.error
import urllib.request


class GitHubAppAuthError(RuntimeError):
    """Safe category for logging; never includes response bodies or credentials."""


def load_private_key(pem):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = serialization.load_pem_private_key(pem.replace("\\n", "\n").encode(), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("GitHub App requires an RSA private key")
    return key


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubApp:
    def __init__(self, app_id, private_key):
        self.app_id = app_id
        self._key = load_private_key(private_key)
        self._opener = urllib.request.build_opener(_NoRedirect)

    def _jwt(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding

        def encode(value):
            return base64.urlsafe_b64encode(value).rstrip(b"=")

        now = int(time.time())
        header = encode(b'{"alg":"RS256","typ":"JWT"}')
        payload = encode(json.dumps({"iat": now - 60, "exp": now + 540, "iss": self.app_id}).encode())
        message = header + b"." + payload
        signature = self._key.sign(message, padding.PKCS1v15(), hashes.SHA256())
        return (message + b"." + encode(signature)).decode()

    def _request(self, method, path, body=None):
        request = urllib.request.Request("https://api.github.com" + path,
            data=json.dumps(body).encode() if body is not None else None, method=method,
            headers={"Authorization": "Bearer " + self._jwt(),
                     "Accept": "application/vnd.github+json", "Content-Type": "application/json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "sciencediscovery-bot"})
        try:
            with self._opener.open(request, timeout=30) as response:
                return json.load(response)
        except (OSError, ValueError) as err:
            if isinstance(err, urllib.error.HTTPError):
                err.close()
            raise GitHubAppAuthError("GitHub App authentication failed") from None

    def token_for(self, repository, *, write=False):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("invalid repository")
        installation = self._request("GET", f"/repos/{repository}/installation")
        installation_id = installation.get("id")
        if not isinstance(installation_id, int) or installation_id <= 0 or installation.get("suspended_at"):
            raise GitHubAppAuthError("GitHub App installation unavailable")
        permissions = {"metadata": "read", "contents": "write" if write else "read"}
        if not write:
            permissions.update(issues="read", pull_requests="read", actions="read", checks="read", statuses="read")
        result = self._request("POST", f"/app/installations/{installation_id}/access_tokens",
                               {"repositories": [repository.split("/")[1]], "permissions": permissions})
        try:
            token = result["token"]
            expires = datetime.fromisoformat(result["expires_at"].replace("Z", "+00:00")).timestamp()
            # A publication subprocess is bounded to ten minutes. Mint afresh on
            # every attempt so retries and separate organizations cannot reuse tokens.
            if not isinstance(token, str) or not token or expires <= time.time() + 660:
                raise ValueError()
        except (KeyError, TypeError, ValueError):
            raise GitHubAppAuthError("Invalid installation token response") from None
        return token
