"""Shared test helpers: fixture loading and signed request construction (reuses scripts/replay.py)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import replay  # noqa: E402  (scripts/replay.py)

FIXTURES = ROOT / "fixtures"
SECRET = "test-secret-do-not-use"


def fixture_path(name: str) -> Path:
    """``github/ping`` -> fixtures/github/ping.json"""
    return FIXTURES / f"{name}.json"


def fixture(name: str) -> dict:
    return json.loads(fixture_path(name).read_text(encoding="utf-8"))


def signed(name: str, secret: str | None = SECRET, **kw) -> tuple[dict, bytes]:
    """Headers and body exactly as the replay tool would send them."""
    req = replay.prepare(fixture_path(name), secret, **kw)
    return req.headers, req.body


def all_fixture_names() -> list[str]:
    return sorted(str(p.relative_to(FIXTURES).with_suffix("")) for p in FIXTURES.rglob("*.json"))
