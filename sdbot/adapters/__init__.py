"""Provider detection plus normalisation of platform payloads into the unified Event."""

from __future__ import annotations

from ..events import Event
from ..signature import header
from . import gitcode, github

ADAPTERS = {"github": github, "gitcode": gitcode}


def detect_provider(headers) -> str | None:
    """GitHub sends ``X-GitHub-Event``; GitCode sends ``X-GitCode-Event``."""
    if header(headers, github.EVENT_HEADER):
        return "github"
    if header(headers, gitcode.EVENT_HEADER):
        return "gitcode"
    return None


def normalize(provider: str, headers, payload: dict) -> Event:
    return ADAPTERS[provider].normalize(headers, payload)
