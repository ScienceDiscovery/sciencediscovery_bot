#!/usr/bin/env python3
"""Replay fixture deliveries against a running bot, signed like the real platform would.

    python3 scripts/replay.py fixtures/github/pull_request_closed_merged.json
    python3 scripts/replay.py --all                      # every fixture, sorted
    python3 scripts/replay.py --all fixtures/gitcode     # one provider
    python3 scripts/replay.py --bad-signature fixtures/github/ping.json   # expect 401
    python3 scripts/replay.py --print-curl fixtures/github/ping.json      # equivalent curl

A fixture is an envelope: {"provider", "event", "delivery", "description", "payload"}.
The secret comes from SDBOT_<PROVIDER>_WEBHOOK_SECRET (or SDBOT_WEBHOOK_SECRET); with no
secret the request is sent unsigned, which only an unsigned-mode server accepts. Each
run uses a fresh delivery id unless --keep-delivery-id is given, because the server
treats a repeated id as a redelivery and skips the hooks.

The webhook listener answers with the bare minimum, so after each POST the tool asks the
admin listener (--admin-url, default http://127.0.0.1:8792) for the event-log record to
show route / hooks / duplicate. Without an admin listener only the HTTP status is shown.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

from sdbot.config import SECRET_ENV  # noqa: E402
from sdbot.signature import sign  # noqa: E402

DEFAULT_URL = "http://127.0.0.1:8791/webhook"
DEFAULT_ADMIN_URL = "http://127.0.0.1:8792"
FIXTURES_DIR = HERE / "fixtures"


@dataclass
class Prepared:
    name: str
    provider: str
    event: str
    delivery: str
    description: str
    headers: dict = field(default_factory=dict)
    body: bytes = b""


def load_fixture(path: Path) -> dict:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("provider", "event", "payload"):
        if key not in doc:
            raise ValueError(f"{path}: fixture envelope lacks {key!r}")
    return doc


def secret_from_env(provider: str, override_env: str | None = None) -> str | None:
    names = (override_env,) if override_env else SECRET_ENV.get(provider, ())
    for name in names:
        value = os.environ.get(name or "")
        if value:
            return value
    return None


def prepare(path: Path, secret: str | None, fresh_delivery: bool = True, bad_signature: bool = False,
            no_signature: bool = False, token_mode: bool = False) -> Prepared:
    doc = load_fixture(path)
    provider, event = doc["provider"], doc["event"]
    delivery = f"replay-{uuid.uuid4()}" if fresh_delivery else (doc.get("delivery") or f"replay-{uuid.uuid4()}")
    body = json.dumps(doc["payload"], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "*/*"}
    signature = None if no_signature or not secret else sign(body, secret)
    if bad_signature:
        signature = "sha256=" + "0" * 64
    if provider == "github":
        headers.update({"User-Agent": "GitHub-Hookshot/replay", "X-GitHub-Event": event, "X-GitHub-Delivery": delivery,
                        "X-GitHub-Hook-ID": "555001", "X-GitHub-Hook-Installation-Target-Type": "integration",
                        "X-GitHub-Hook-Installation-Target-ID": "987654"})
        if signature:
            headers["X-Hub-Signature-256"] = signature
    elif provider == "gitcode":
        headers.update({"User-Agent": "GitCode-Hookshot/replay", "X-GitCode-Event": event, "X-GitCode-Delivery": delivery})
        if token_mode and secret and not no_signature:
            headers["X-GitCode-Token"] = "wrong-token" if bad_signature else secret
        elif signature:
            headers["X-GitCode-Signature-256"] = signature
    else:
        raise ValueError(f"{path}: unknown provider {provider!r}")
    return Prepared(Path(path).stem, provider, event, delivery, doc.get("description", ""), headers, body)


def send(req: Prepared, url: str, timeout: float = 10.0) -> tuple[int, dict]:
    request = Request(url, data=req.body, headers=req.headers, method="POST")
    try:
        with urlopen(request, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except HTTPError as err:
        try:
            return err.code, json.loads(err.read().decode("utf-8") or "{}")
        except ValueError:
            return err.code, {"error": str(err)}
    except URLError as err:
        raise SystemExit(f"cannot reach {url}: {err.reason} (is the server running? ./run.sh start)")


def lookup(admin_url: str, delivery: str, token: str | None, timeout: float = 5.0) -> dict | None:
    """Event-log record for ``delivery`` from the admin listener; None when it is unreachable or off."""
    if not admin_url:
        return None
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = Request(f"{admin_url.rstrip('/')}/api/events?limit=1&delivery_id={delivery}", headers=headers)
    try:
        with urlopen(request, timeout=timeout) as resp:
            events = json.loads(resp.read().decode("utf-8")).get("events") or []
    except (HTTPError, URLError, ValueError):
        return None
    return events[0] if events else None


def as_curl(req: Prepared, url: str) -> str:
    """Self-contained shell command that sends the exact same bytes (printf keeps the body byte-exact)."""
    quoted = req.body.decode("utf-8").replace("'", "'\\''")
    # Password mode carries the secret itself; printed commands must defer to the environment.
    header_args = " \\\n  ".join(('-H "X-GitCode-Token: ${SDBOT_GITCODE_WEBHOOK_SECRET:-${SDBOT_WEBHOOK_SECRET:?Set webhook secret}}"'
        if k == "X-GitCode-Token" else f"-H '{k}: {v}'") for k, v in req.headers.items())
    return f"printf '%s' '{quoted}' | curl -sS -X POST '{url}' \\\n  {header_args} \\\n  --data-binary @-"


def collect(paths: list[str], all_dir: str | None) -> list[Path]:
    if all_dir is not None:
        root = Path(all_dir) if all_dir else FIXTURES_DIR
        return sorted(p for p in root.rglob("*.json"))
    return [Path(p) for p in paths]


def run(argv=None, out=sys.stdout) -> list[dict]:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("fixtures", nargs="*", help="fixture files (envelope JSON)")
    parser.add_argument("--all", nargs="?", const="", metavar="DIR", help="replay every fixture under DIR (default fixtures/)")
    parser.add_argument("--url", default=os.environ.get("SDBOT_REPLAY_URL", DEFAULT_URL))
    parser.add_argument("--admin-url", default=os.environ.get("SDBOT_REPLAY_ADMIN_URL", DEFAULT_ADMIN_URL),
                        help="admin listener used to show route/hooks after each delivery ('' to skip)")
    parser.add_argument("--secret-env", help="environment variable holding the secret (default SDBOT_<PROVIDER>_WEBHOOK_SECRET)")
    parser.add_argument("--no-signature", action="store_true", help="send without any signature header")
    parser.add_argument("--bad-signature", action="store_true", help="send a wrong signature / token")
    parser.add_argument("--token-mode", action="store_true", help="GitCode password mode (X-GitCode-Token) instead of the signature header")
    parser.add_argument("--keep-delivery-id", action="store_true", help="reuse the fixture's delivery id (server will flag redeliveries)")
    parser.add_argument("--print-curl", action="store_true", help="print an equivalent curl command instead of sending")
    parser.add_argument("--expect", type=int, help="expected HTTP status (default 200, or 401 for --bad/--no-signature with a secret)")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)

    paths = collect(args.fixtures, args.all)
    if not paths:
        parser.error("no fixtures given (pass files or --all)")
    results = []
    for path in paths:
        provider = load_fixture(path)["provider"]
        secret = secret_from_env(provider, args.secret_env)
        req = prepare(path, secret, fresh_delivery=not args.keep_delivery_id, bad_signature=args.bad_signature,
                      no_signature=args.no_signature, token_mode=args.token_mode)
        url = args.url
        if args.print_curl:
            print(f"# {path} — {req.description}", file=out)
            print(as_curl(req, url) + "\n", file=out)
            continue
        expected = args.expect or (401 if secret and (args.bad_signature or args.no_signature) else 200)
        status, reply = send(req, url, args.timeout)
        record = lookup(args.admin_url, req.delivery, os.environ.get("SDBOT_ADMIN_TOKEN"))
        ok = status == expected
        results.append({"fixture": str(path), "status": status, "expected": expected, "ok": ok, "reply": reply, "record": record})
        if record:
            route = record.get("route") or ""
            if record.get("status") == "rejected":
                route = record.get("reason") or route
            hooks = ",".join(record.get("hooks") or []) or "-"
            extra = " DUPLICATE" if record.get("duplicate") else ""
        else:
            route, hooks, extra = reply.get("error") or ("pong" if reply.get("pong") else "accepted"), "?", " (admin listener not reachable)"
        flag = "OK " if ok else "BAD"
        print(f"{flag} {status} {req.provider:<7} {route:<32} hooks={hooks}{extra}  {path.relative_to(HERE) if path.is_absolute() and HERE in path.parents else path}", file=out)
    return results


def main(argv=None) -> int:
    results = run(argv)
    bad = [r for r in results if not r["ok"]]
    if results:
        print(f"{len(results) - len(bad)}/{len(results)} deliveries answered as expected")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
