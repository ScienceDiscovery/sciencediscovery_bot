#!/usr/bin/env python3
"""Entry point: ``python3 server.py`` starts two listeners.

Webhook listener (default 127.0.0.1:8791) — the only one a tunnel may forward:

    POST /webhook             GitHub or GitCode delivery (provider detected from headers)
    POST /webhook/github      same, provider forced (use this URL in the GitHub App)
    POST /webhook/gitcode     same, provider forced (use this URL in the GitCode repo webhook)
    GET  /healthz             {"ok": true}
    anything else             404, JSON, no version or path information

Admin listener (default 127.0.0.1:8792) — status / event log / replay panel, never forwarded:

    GET  /                    panel (static/index.html)
    GET  /healthz             liveness with uptime
    GET  /api/status          config view (no secrets), counters, last record
    GET  /api/events          event-log records; ?limit= &kind= &route= &repo= &number= &status= &provider= &action= &delivery_id=
    POST /api/replay/<id>     re-feed a stored payload through the pipeline (signed with the configured secret)

The admin listener refuses requests that arrive through a Cloudflare tunnel (Cf-* headers)
and, when SDBOT_ADMIN_TOKEN is set, protects data/replay endpoints with
``Authorization: Bearer <token>``. The static shell can load before authenticating.
"""

from __future__ import annotations

import argparse
import hmac
import logging
import socket
import sys
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sdbot import __version__  # noqa: E402
from sdbot.config import PROVIDERS, Config  # noqa: E402
from sdbot.adapters import detect_provider  # noqa: E402
from sdbot.pipeline import Pipeline  # noqa: E402
from sdbot.router import Router  # noqa: E402
from sdbot.signature import sign  # noqa: E402
from sdbot.store import EventStore, json_bytes  # noqa: E402
from sdbot.board import MultiBoardUpdater  # noqa: E402

log = logging.getLogger("sdbot.server")
ADMIN_WRITE_MARKER = "sciencediscovery-bot"                 # X-Requested-With value required on admin POSTs
GET_FILTERS = ("kind", "route", "repo", "number", "status", "provider", "action", "delivery_id")
EVENT_HEADER = {"github": "X-GitHub-Event", "gitcode": "X-GitCode-Event"}
DELIVERY_HEADER = {"github": "X-GitHub-Delivery", "gitcode": "X-GitCode-Delivery"}
SIGNATURE_HEADER = {"github": "X-Hub-Signature-256", "gitcode": "X-GitCode-Signature-256"}


class BotServer(ThreadingHTTPServer):
    """HTTP server that carries the shared pipeline and config for its handler."""

    daemon_threads = True

    def __init__(self, address, handler, pipeline: Pipeline, cfg: Config):
        self.pipeline = pipeline
        self.cfg = cfg
        self.started_at = time.time()
        super().__init__(address, handler)


class JSONHandler(BaseHTTPRequestHandler):
    """Common plumbing: JSON replies, JSON error pages (no HTML, no version banner), access log."""

    server_version = "sciencediscovery-bot"
    sys_version = ""
    server: BotServer

    def version_string(self) -> str:  # no Python version in the Server header
        return self.server_version

    def log_message(self, format, *args):  # noqa: A002
        # URLs and headers can contain credentials, including legacy ?token= links.
        # Never interpolate client-supplied text into the access log.
        status = str(args[1]) if format == '"%s" %s %s' and len(args) > 1 else "error"
        sys.stderr.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {self.listener} {self.client_address[0]} status={status}\n")

    listener = "?"

    def _json(self, payload, status: int = 200) -> None:
        body = json_bytes(payload)
        headers = {"Server": self.version_string(), "Date": self.date_time_string(),
                   "Content-Type": "application/json; charset=utf-8", "Content-Length": str(len(body)),
                   "Cache-Control": "no-store"}
        try:
            self._before_json(payload, status, headers)
        except OSError:
            # Do not acknowledge a delivery whose archive could not be committed.
            log.exception("delivery archive write failed")
            status = 503
            body = json_bytes({"ok": False, "error": "storage unavailable"})
            headers["Content-Length"] = str(len(body))
        self.log_request(status)
        self.send_response_only(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _before_json(self, payload, status: int, headers: dict) -> None:
        pass

    def send_error(self, code, message=None, explain=None):  # JSON instead of the default HTML page
        try:
            short = HTTPStatus(code).phrase.lower()
        except ValueError:
            short = "error"
        self._json({"ok": False, "error": short}, code)



class WebhookHandler(JSONHandler):
    """Public surface: bare webhook protocol, minimal answers, nothing about the deployment."""

    listener = "webhook"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def _before_json(self, payload, status: int, headers: dict) -> None:
        # Health probes and ordinary GETs are not deliveries. Error responses to POSTs
        # (including wrong URLs) are archived at the same boundary as successful ones.
        if getattr(self, "headers", None) is None:
            return
        if self.command in ("GET", "HEAD") and not self.headers.get("X-GitHub-Event") and not self.headers.get("X-GitCode-Event"):
            return
        record = getattr(self, "_delivery_record", None)
        if record is None:
            record = self.server.pipeline.store.rejected_record(
                detect_provider(self.headers), self.headers.get("X-GitHub-Delivery") or self.headers.get("X-GitCode-Delivery", ""),
                self.headers.get("X-GitHub-Event") or self.headers.get("X-GitCode-Event", ""), payload.get("error", "request rejected"), status)
        context = {"source": "webhook", "method": self.command, "path": self.path,
                   "body_complete": getattr(self, "_body_complete", False),
                   "declared_body_bytes": getattr(self, "_declared_length", None),
                   "capture_note": getattr(self, "_capture_note", "body not read"),
                   "duration_ms": round((time.monotonic() - getattr(self, "_started", time.monotonic())) * 1000, 2)}
        self.server.pipeline.store.save(record, self.headers, getattr(self, "_body", b""), payload, status, context, headers)

    def _read_body(self) -> bytes | None:
        self._body = b""
        self._body_complete = False
        self._capture_note = ""
        if self.headers.get("Transfer-Encoding"):
            self._capture_note = "unsupported transfer encoding; body not read"
            self._json({"ok": False, "error": "unsupported transfer encoding"}, 400)
            return None
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length < 0:
                raise ValueError
        except ValueError:
            self._capture_note = "invalid Content-Length; body not read"
            self._json({"ok": False, "error": "bad request"}, 400)
            return None
        self._declared_length = length
        maximum = self.server.cfg.max_body_bytes
        remaining = min(length, maximum)
        chunks = []
        try:
            while remaining:
                chunk = self.rfile.read1(min(remaining, 64 * 1024))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
        except (socket.timeout, ConnectionError):
            self._capture_note = "request body interrupted or timed out"
        self._body = b"".join(chunks)
        self._body_complete = len(self._body) == length
        if length > maximum:
            self._capture_note = "body exceeds request limit; only received prefix retained"
            self._json({"ok": False, "error": "payload too large"}, 413)
            return None
        if not self._body_complete:
            self._capture_note = self._capture_note or "incomplete request body"
            self._json({"ok": False, "error": "incomplete body"}, 400)
            return None
        return self._body

    def do_GET(self):  # noqa: N802
        if urlsplit(self.path).path == "/healthz":
            return self._json({"ok": True})
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):  # noqa: N802
        self._started = time.monotonic()
        body = self._read_body()
        if body is None:
            return None
        route = urlsplit(self.path).path
        if route == "/webhook":
            provider = None
        elif route.startswith("/webhook/") and route[len("/webhook/"):] in PROVIDERS:
            provider = route[len("/webhook/"):]
        else:
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            reply = self.server.pipeline.receive(self.headers, body, provider_hint=provider, persist=False)
        except Exception:  # last line of defence; the pipeline already contains hook errors
            log.exception("unhandled error while processing a delivery")
            return self._json({"ok": False, "error": "internal error"}, 500)
        self._delivery_record = reply.record
        return self._json(reply.body, reply.status)


class AdminHandler(JSONHandler):
    """Loopback-only panel. Anything that looks tunnelled is refused before routing."""

    listener = "admin"

    def _guard(self, *, require_token: bool = True) -> bool:
        if any(name.lower().startswith("cf-") for name in self.headers):
            self._json({"ok": False, "error": "admin listener must not be reached through a tunnel"}, 403)
            return False
        token = self.server.cfg.admin_token
        if token and require_token:
            auth = self.headers.get("Authorization", "")
            if not (auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().encode(), token.encode())):
                self._json({"ok": False, "error": "admin token required"}, 401)
                return False
        return True

    def do_GET(self):  # noqa: N802
        url = urlsplit(self.path)
        # The shell has no deployment data. Load it before JS sends Authorization;
        # all data endpoints remain protected, and the tunnel guard also covers HTML.
        if not self._guard(require_token=url.path not in ("/", "/index.html")):
            return None
        store = self.server.pipeline.store
        if url.path in ("/", "/index.html"):
            return self._file(self.server.cfg.static_dir / "index.html")
        if url.path == "/healthz":
            return self._json({"ok": True, "uptime_s": round(time.time() - self.server.started_at, 1)})
        if url.path == "/api/status":
            board = self.server.pipeline.router.board
            return self._json({"ok": True, "version": __version__, "started_at": self.server.started_at,
                               "board": board.status() if isinstance(board, MultiBoardUpdater) else {"enabled": False},
                               "config": self.server.cfg.public(), **store.status()})
        if url.path == "/api/listeners":
            return self._json({"ok": True, "listeners": self.server.pipeline.router.bus.inventory(),
                               "repositories": list(self.server.cfg.repos)})
        if url.path == "/api/events":
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                limit = max(1, min(int(query.pop("limit", 50)), 500))
                offset = max(0, int(query.pop("offset", 0)))
            except ValueError:
                return self._json({"ok": False, "error": "limit and offset must be integers"}, 400)
            filters = {k: query[k] for k in GET_FILTERS if k in query}
            events = store.recent(limit + 1, offset=offset, **filters)
            return self._json({"ok": True, "count": len(events[:limit]), "events": events[:limit],
                               "offset": offset, "has_more": len(events) > limit})
        if url.path.startswith("/api/events/"):
            detail = store.detail(unquote(url.path[len("/api/events/"):]))
            if detail is None:
                return self._json({"ok": False, "error": "delivery not found"}, 404)
            return self._json({"ok": True, **detail})
        if url.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return None
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):  # noqa: N802
        if not self._guard():
            return None
        route = urlsplit(self.path).path
        if not route.startswith("/api/replay/"):
            return self.send_error(HTTPStatus.NOT_FOUND)
        if self.headers.get("X-Requested-With") != ADMIN_WRITE_MARKER:
            return self._json({"ok": False, "error": f"admin writes need X-Requested-With: {ADMIN_WRITE_MARKER}"}, 403)
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            return self._json({"ok": False, "error": "cross-origin admin write refused"}, 403)
        return self._replay(unquote(route[len("/api/replay/"):]))

    def _replay(self, delivery_id: str) -> None:
        """Re-feed a stored payload as a fresh delivery, signed with the configured secret (or unsigned when none)."""
        store = self.server.pipeline.store
        record = store.find(delivery_id)
        if record is None:
            return self._json({"ok": False, "error": "delivery not found"}, 404)
        provider = record.get("provider") or ""
        body = store.payload_bytes(record)
        if provider not in PROVIDERS or body is None or record.get("body_complete") is False:
            return self._json({"ok": False, "error": "no stored payload for this delivery"}, 409)
        detail = store.detail(record["record_id"])
        original_headers = detail["request"].get("headers", {})
        content_type = next((v for k, v in original_headers.items() if k.lower() == "content-type"), "application/json")
        headers = {"Content-Type": content_type, EVENT_HEADER[provider]: record.get("raw_event") or "",
                   DELIVERY_HEADER[provider]: f"replay-{uuid.uuid4()}"}
        secret = self.server.cfg.secret_for(provider)
        if secret:
            headers[SIGNATURE_HEADER[provider]] = sign(body, secret)
        reply = self.server.pipeline.receive(headers, body, provider_hint=provider,
            request={"source": "replay", "method": "POST", "path": f"/webhook/{provider}",
                     "replayed_from": record["record_id"]})
        return self._json({"ok": reply.status == 200, "status": reply.status, "record": reply.record}, reply.status)

    def _file(self, path: Path) -> None:
        if not path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)


def build(cfg: Config) -> Pipeline:
    store = EventStore(cfg.data_dir, dedupe_window=cfg.dedupe_window)
    return Pipeline(cfg, store, Router(board=MultiBoardUpdater(cfg) if cfg.publication_targets() else None))


def serve(cfg: Config, pipeline: Pipeline) -> int:
    webhook = BotServer((cfg.webhook_host, cfg.webhook_port), WebhookHandler, pipeline, cfg)
    admin = BotServer((cfg.admin_host, cfg.admin_port), AdminHandler, pipeline, cfg) if cfg.admin_enabled else None
    print(f"sciencediscovery-bot {__version__}: webhook http://{cfg.webhook_host}:{cfg.webhook_port}/webhook  "
          f"admin {'http://%s:%d/' % (cfg.admin_host, cfg.admin_port) if admin else 'disabled'}  "
          f"data={cfg.data_dir}  repos={','.join(cfg.repos) or '*'}", flush=True)
    threads = []
    if isinstance(pipeline.router.board, MultiBoardUpdater):
        pipeline.router.board.start()
    if admin:
        threads.append(threading.Thread(target=admin.serve_forever, name="admin", daemon=True))
        threads[-1].start()
    try:
        webhook.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if isinstance(pipeline.router.board, MultiBoardUpdater):
            pipeline.router.board.stop()
        webhook.server_close()
        if admin:
            admin.shutdown()
            admin.server_close()
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Local webhook receiver for sciencediscovery")
    parser.add_argument("--webhook-host", help="webhook bind address (default: $SDBOT_WEBHOOK_HOST or 127.0.0.1)")
    parser.add_argument("--webhook-port", type=int, help="webhook port (default: $SDBOT_WEBHOOK_PORT or 8791)")
    parser.add_argument("--admin-host", help="admin bind address (default: $SDBOT_ADMIN_HOST or 127.0.0.1)")
    parser.add_argument("--admin-port", type=int, help="admin port (default: $SDBOT_ADMIN_PORT or 8792)")
    parser.add_argument("--no-admin", action="store_true", help="do not start the admin listener")
    parser.add_argument("--data-dir", help="event log directory (default: $SDBOT_DATA_DIR or ./.data)")
    args = parser.parse_args(argv)

    cfg = Config.from_env(webhook_host=args.webhook_host, webhook_port=args.webhook_port, admin_host=args.admin_host,
                          admin_port=args.admin_port, admin_enabled=False if args.no_admin else None,
                          data_dir=Path(args.data_dir) if args.data_dir else None)
    logging.basicConfig(level=getattr(logging, cfg.log_level, logging.INFO), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    problems = cfg.validate()
    if problems:
        for problem in problems:
            print(f"refusing to start: {problem}", file=sys.stderr)
        return 2
    for provider in PROVIDERS:
        if not cfg.secret_for(provider):
            log.warning("%s deliveries are accepted UNSIGNED: set SDBOT_%s_WEBHOOK_SECRET before exposing the webhook port",
                        provider, provider.upper())
    if cfg.admin_enabled and cfg.admin_host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("admin listener bound to %s: publish it to loopback only (compose does 127.0.0.1:%d) and never tunnel it",
                    cfg.admin_host, cfg.admin_port)
    return serve(cfg, build(cfg))


if __name__ == "__main__":
    sys.exit(main())
