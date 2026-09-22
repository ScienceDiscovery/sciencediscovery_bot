"""Durable delivery archive: a small JSONL index plus request bodies and exchange details.

Each attempt has its own record_id, including rejected and duplicate deliveries. Old
JSONL records and payload paths remain readable; missing historical data is not invented.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

from .events import Event
from .router import Outcome
from .signature import Verification

_SENSITIVE_HEADER = re.compile(r"authorization|cookie|token|secret|signature|api[-_]?key", re.I)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime())


def safe_headers(headers) -> dict:
    return {name: "[REDACTED]" if _SENSITIVE_HEADER.search(name) else value for name, value in headers.items()}


def safe_target(target: str) -> str:
    parsed = urlsplit(target)
    # Query values can contain credentials. Keep parameter names for diagnosis only.
    query = urlencode([(key, "[REDACTED]") for key, _ in parse_qsl(parsed.query, keep_blank_values=True)])
    return parsed.path + ("?" + query if query else "")


def json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class EventStore:
    def __init__(self, data_dir: Path, dedupe_window: int = 2000):
        self.data_dir = Path(data_dir)
        self.events_path = self.data_dir / "events.jsonl"
        self.dedupe_window = dedupe_window
        self._lock = threading.RLock()
        self._seen: OrderedDict[str, None] = OrderedDict()
        self.counts = {"accepted": 0, "rejected": 0, "ignored": 0, "duplicate": 0, "by_route": {}}
        self.last: dict | None = None
        self.data_dir.mkdir(parents=True, exist_ok=True)
        # Restore lifetime counters as well as recent delivery IDs after restart.
        if self.events_path.exists():
            with self.events_path.open("rb") as stream:
                for line in stream:
                    record = self._parse(line.strip())
                    if record is not None:
                        self._count(record)

    @staticmethod
    def _parse(line: bytes) -> dict | None:
        if not line:
            return None
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                return None
            record.setdefault("record_id", "legacy-" + hashlib.sha256(line).hexdigest())
            return record
        except (ValueError, UnicodeDecodeError):
            return None

    def seen(self, provider: str, delivery_id: str) -> bool:
        with self._lock:
            return bool(delivery_id) and f"{provider}:{delivery_id}" in self._seen

    def _count(self, record: dict) -> None:
        status = record.get("status", "rejected")
        self.counts[status] = self.counts.get(status, 0) + 1
        if record.get("duplicate"):
            self.counts["duplicate"] += 1
        elif status == "accepted":
            routes = self.counts["by_route"]
            route = record.get("route", "")
            routes[route] = routes.get(route, 0) + 1
        if status == "accepted" and record.get("delivery_id"):
            key = f"{record.get('provider')}:{record['delivery_id']}"
            self._seen[key] = None
            self._seen.move_to_end(key)
            while len(self._seen) > self.dedupe_window:
                self._seen.popitem(last=False)
        self.last = record

    @staticmethod
    def event_record(event: Event, outcome: Outcome, verification: Verification, status: str = "accepted") -> dict:
        record = event.summary()
        record.update(received_at=now_iso(), status=status, route=outcome.route, handled=outcome.handled,
                      hooks=outcome.hook_names(), errors=list(outcome.errors), duplicate=outcome.duplicate,
                      note=outcome.note, verification=verification.mode, listeners=list(outcome.listeners))
        return record

    @staticmethod
    def rejected_record(provider, delivery: str, raw_event: str, reason: str, http_status: int) -> dict:
        return {"received_at": now_iso(), "status": "rejected", "provider": provider or "", "delivery_id": delivery,
                "raw_event": raw_event, "kind": "", "action": "", "route": "rejected", "handled": False,
                "reason": reason, "http_status": http_status, "hooks": []}

    def _write(self, relative: Path, data: bytes) -> None:
        target = self.data_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Files are private and are complete before the index makes them visible.
        with target.open("xb") as stream:
            os.chmod(target, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def save(self, record: dict, headers, body: bytes, response_body: dict, response_status: int,
             request: dict | None = None, response_headers: dict | None = None) -> None:
        context = dict(request or {})
        record_id = uuid.uuid4().hex
        day = time.strftime("%Y-%m-%d")
        payload_file = Path("payloads") / day / f"{record_id}.body"
        detail_file = Path("deliveries") / day / f"{record_id}.json"
        reply_bytes = json_bytes(response_body)
        request_doc = {"method": context.pop("method", "POST"), "path": safe_target(context.pop("path", "/webhook")),
                       "headers": safe_headers(headers), "body_complete": context.pop("body_complete", True),
                       "body_bytes": len(body), **context}
        detail = {"request": request_doc, "response": {
            "status": response_status, "headers": response_headers or {
                "Content-Type": "application/json; charset=utf-8", "Content-Length": str(len(reply_bytes)),
                "Cache-Control": "no-store"}, "body": reply_bytes.decode("utf-8")}}
        record.update(record_id=record_id, payload_file=str(payload_file), detail_file=str(detail_file),
                      payload_bytes=len(body), http_status=response_status, body_complete=request_doc["body_complete"],
                      request_method=request_doc["method"], request_path=request_doc["path"])
        if request_doc.get("replayed_from"):
            record.setdefault("extra", {})["replayed_from"] = request_doc["replayed_from"]
        with self._lock:
            self._write(payload_file, body)
            self._write(detail_file, json_bytes(detail))
            with self.events_path.open("ab") as stream:
                os.chmod(self.events_path, 0o600)
                stream.write(json_bytes(record) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            self._count(record)

    def _reverse_records(self):
        """Read the entire history backwards in bounded chunks, stopping once a query is satisfied."""
        if not self.events_path.exists():
            return
        with self.events_path.open("rb") as stream:
            position = stream.seek(0, 2)
            pending = b""
            while position:
                size = min(position, 64 * 1024)
                position -= size
                stream.seek(position)
                parts = (stream.read(size) + pending).split(b"\n")
                pending = parts[0]
                for line in reversed(parts[1:]):
                    record = self._parse(line)
                    if record is not None:
                        yield record
            record = self._parse(pending)
            if record is not None:
                yield record

    def recent(self, limit: int = 50, *, offset: int = 0, **filters) -> list[dict]:
        wanted = {key: value for key, value in filters.items() if value not in (None, "")}
        out = []
        with self._lock:
            for record in self._reverse_records():
                if not all(str(record.get(key)) == str(value) for key, value in wanted.items()):
                    continue
                if offset:
                    offset -= 1
                    continue
                out.append(record)
                if len(out) >= limit:
                    break
        return out

    def find(self, identifier: str) -> dict | None:
        # A record_id selects one exact attempt. A delivery_id remains supported for old clients.
        exact = self.recent(1, record_id=identifier)
        matches = exact or self.recent(1, delivery_id=identifier)
        return matches[0] if matches else None

    def _read_file(self, relative: str | None) -> bytes | None:
        if not relative:
            return None
        path = (self.data_dir / relative).resolve()
        if self.data_dir.resolve() not in path.parents or not path.is_file():
            return None
        return path.read_bytes()

    def payload_bytes(self, record: dict) -> bytes | None:
        return self._read_file(record.get("payload_file"))

    def detail(self, identifier: str) -> dict | None:
        record = self.find(identifier)
        if record is None:
            return None
        raw = self._read_file(record.get("detail_file"))
        detail = json.loads(raw) if raw is not None else {"request": {}, "response": None}
        body = self.payload_bytes(record)
        request = detail["request"]
        request["body_available"] = body is not None
        request["body"] = None
        if body is not None:
            try:
                request.update(body=body.decode("utf-8"), body_encoding="utf-8")
            except UnicodeDecodeError:
                request.update(body=base64.b64encode(body).decode("ascii"), body_encoding="base64")
        return {"record": record, **detail, "legacy": raw is None}

    def status(self) -> dict:
        with self._lock:
            return {"counts": json.loads(json.dumps(self.counts)), "last": self.last,
                    "events_file": str(self.events_path), "remembered_deliveries": len(self._seen)}
