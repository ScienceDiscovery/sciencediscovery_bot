"""One delivery in, one reply out: verify -> parse -> normalise -> filter -> route -> record.

The pipeline is HTTP-agnostic so tests, the replay tooling and the admin replay action can
drive it directly; server.py only reads the body and hands headers + bytes over.

``Reply.body`` is what the platform gets back and is deliberately minimal (ok / delivery id /
pong). Everything else about the delivery (route, hooks, errors, payload file, rejection
reason) lives in ``Reply.record`` = the event-log line, readable through the admin listener.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from urllib.parse import parse_qs

from .adapters import ADAPTERS, detect_provider, normalize
from .config import Config
from .events import KIND_PING
from .router import Outcome, Router
from .signature import header, verify
from .store import EventStore


@dataclass
class Reply:
    status: int
    body: dict                 # minimal public answer
    record: dict | None = None  # event-log record (accepted / rejected / ignored)


def parse_body(headers, body: bytes) -> dict:
    """JSON object, or the ``payload=`` field of a form-encoded delivery (GitHub option)."""
    ctype = (header(headers, "Content-Type") or "").split(";", 1)[0].strip().lower()
    text = body.decode("utf-8")
    if ctype == "application/x-www-form-urlencoded":
        text = (parse_qs(text).get("payload") or [""])[0]
    doc = json.loads(text or "null")
    if not isinstance(doc, dict):
        raise ValueError("body must be a JSON object")
    return doc


class Pipeline:
    def __init__(self, cfg: Config, store: EventStore, router: Router, log: logging.Logger | None = None):
        self.cfg = cfg
        self.store = store
        self.router = router
        self.log = log or logging.getLogger("sdbot.pipeline")

    def receive(self, headers, body: bytes, provider_hint: str | None = None, *,
                request: dict | None = None, persist: bool = True) -> Reply:
        reply = self._process(headers, body, provider_hint)
        if persist:
            self.store.save(reply.record, headers, body, reply.body, reply.status, request)
        return reply

    def _process(self, headers, body: bytes, provider_hint: str | None = None) -> Reply:
        provider = provider_hint or detect_provider(headers)
        delivery = header(headers, "X-GitHub-Delivery") or header(headers, "X-GitCode-Delivery") or ""
        raw_event = header(headers, "X-GitHub-Event") or header(headers, "X-GitCode-Event") or ""
        if provider not in ADAPTERS:
            return self._reject(provider, delivery, raw_event, 400, "bad request",
                                "unknown provider: expected X-GitHub-Event or X-GitCode-Event", body)

        verification = verify(provider, headers, body, self.cfg.secret_for(provider))
        if not verification.ok:
            return self._reject(provider, delivery, raw_event, 401, "signature verification failed",
                                f"signature verification failed: {verification.reason}", body)

        try:
            payload = parse_body(headers, body)
        except (ValueError, UnicodeDecodeError) as err:
            return self._reject(provider, delivery, raw_event, 400, "bad request", f"invalid body: {err}", body)

        event = normalize(provider, headers, payload)
        if not self.cfg.tracks(event.repo, event.provider) and event.kind != KIND_PING:
            outcome = Outcome(False, event.route, note=f"repo {event.repo} not in SDBOT_REPOS")
            record = self.store.event_record(event, outcome, verification, status="ignored")
            self.log.info("ignored %s from untracked repo %s", event.route, event.repo)
            return Reply(200, {"ok": True, "delivery_id": event.delivery_id}, record)

        if self.store.seen(provider, event.delivery_id):
            outcome = Outcome(False, event.route, duplicate=True, note="redelivery of an already processed delivery id")
        else:
            outcome = self.router.dispatch(event)
        record = self.store.event_record(event, outcome, verification)
        self.log.info("%s %s repo=%s number=%s hooks=%s%s%s", event.provider, outcome.route, event.repo or "-",
                      event.number if event.number is not None else "-", ",".join(outcome.hook_names()) or "-",
                      " DUPLICATE" if outcome.duplicate else "", f" errors={len(outcome.errors)}" if outcome.errors else "")
        body_out = {"ok": True, "delivery_id": event.delivery_id}
        if event.kind == KIND_PING:
            body_out["pong"] = True
        return Reply(200, body_out, record)

    def _reject(self, provider, delivery: str, raw_event: str, status: int, public_reason: str,
                reason: str, body: bytes) -> Reply:
        record = self.store.rejected_record(provider, delivery, raw_event, reason, status)
        self.log.warning("rejected %s delivery=%s event=%s: %s", provider or "?", delivery or "-", raw_event or "-", reason)
        return Reply(status, {"ok": False, "error": public_reason}, record)
