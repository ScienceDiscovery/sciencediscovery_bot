"""Webhook signature verification and signing helpers.

GitHub (baseline): ``X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body>``.
GitCode: ``X-GitCode-Signature-256: sha256=<HMAC-SHA256 of the raw body>`` in "signature"
mode, or ``X-GitCode-Token: <password>`` in "password" mode. GitCode's docs do not say
whether the digest is hex or base64, so both encodings are accepted (each is still a
full MAC over the body with the shared secret). The legacy SHA-1 ``X-Hub-Signature`` is
ignored on purpose.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from dataclasses import dataclass

GITHUB_SIGNATURE_HEADER = "X-Hub-Signature-256"
GITCODE_SIGNATURE_HEADER = "X-GitCode-Signature-256"
GITCODE_TOKEN_HEADER = "X-GitCode-Token"


@dataclass(frozen=True)
class Verification:
    ok: bool
    mode: str        # hmac-sha256 | token | unsigned | rejected
    reason: str = ""


def header(headers, name: str) -> str | None:
    """Case-insensitive header lookup that works for ``email.message.Message`` and plain dicts."""
    value = headers.get(name)
    if value is None:
        wanted = name.lower()
        for key, candidate in headers.items():
            if key.lower() == wanted:
                return candidate
    return value


def verify(provider: str, headers, body: bytes, secret: str | None) -> Verification:
    """Check the delivery against ``secret``. No secret configured means the delivery is
    accepted unsigned; the server logs that mode loudly at startup."""
    if not secret:
        return Verification(True, "unsigned", "no secret configured for this provider")
    if provider == "github":
        return _verify_hmac(header(headers, GITHUB_SIGNATURE_HEADER), body, secret, GITHUB_SIGNATURE_HEADER)
    if provider == "gitcode":
        sig = header(headers, GITCODE_SIGNATURE_HEADER)
        if sig:
            return _verify_hmac(sig, body, secret, GITCODE_SIGNATURE_HEADER, allow_base64=True)
        token = header(headers, GITCODE_TOKEN_HEADER)
        if token is not None:
            if hmac.compare_digest(token.encode("utf-8"), secret.encode("utf-8")):
                return Verification(True, "token")
            return Verification(False, "rejected", f"{GITCODE_TOKEN_HEADER} does not match")
        return Verification(False, "rejected", f"missing {GITCODE_SIGNATURE_HEADER} or {GITCODE_TOKEN_HEADER}")
    return Verification(False, "rejected", f"unknown provider {provider!r}")


def _verify_hmac(value: str | None, body: bytes, secret: str, name: str, allow_base64: bool = False) -> Verification:
    if not value:
        return Verification(False, "rejected", f"missing {name}")
    scheme, _, digest = value.strip().partition("=")
    if scheme.lower() != "sha256" or not digest:
        return Verification(False, "rejected", f"malformed {name}: expected sha256=<digest>")
    mac = hmac.new(secret.encode("utf-8"), body, hashlib.sha256)
    candidates = [mac.hexdigest()]
    if allow_base64:
        candidates.append(base64.b64encode(mac.digest()).decode("ascii"))
    if any(hmac.compare_digest(candidate, digest) for candidate in candidates):
        return Verification(True, "hmac-sha256")
    return Verification(False, "rejected", f"{name} mismatch")


def sign(body: bytes, secret: str) -> str:
    """Header value GitHub would send for ``body``; also what the GitCode adapter accepts."""
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
