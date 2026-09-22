"""Runtime configuration; everything comes from ``SDBOT_*`` environment variables.

Two listeners:
  - webhook  (default 127.0.0.1:8791): the only thing a tunnel may forward. Speaks the
    bare webhook protocol and answers with the minimum the platform needs.
  - admin    (default 127.0.0.1:8792): status / event log / replay panel. Must never be
    forwarded; refuses requests that carry Cloudflare tunnel headers and can require a token.

Webhook secrets and the admin token are read from the environment only. They are kept
in memory and are never written to the event log, payload files, ``/api/status`` or stderr.
"""

from __future__ import annotations

import os
import re
import json
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROVIDERS = ("github", "gitcode")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
RESERVED_PORTS = (4310, 4311)  # local trial stack, never bind these
DEFAULT_REPOS = ("openjiuwen-ai/sciencediscovery", "sciencediscovery/sciencediscovery")

# Secret lookup order per provider; the shared name is a convenience for single-provider setups.
SECRET_ENV = {
    "github": ("SDBOT_GITHUB_WEBHOOK_SECRET", "SDBOT_WEBHOOK_SECRET"),
    "gitcode": ("SDBOT_GITCODE_WEBHOOK_SECRET", "SDBOT_WEBHOOK_SECRET"),
}


def _int(name: str, default: int, *aliases: str) -> int:
    for key in (name, *aliases):
        raw = os.environ.get(key)
        if raw is not None:
            try:
                return int(raw)
            except ValueError:
                return default
    return default


def _str(name: str, default: str, *aliases: str) -> str:
    for key in (name, *aliases):
        raw = os.environ.get(key)
        if raw:
            return raw
    return default


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


@dataclass
class Config:
    webhook_host: str = "127.0.0.1"
    webhook_port: int = 8791
    admin_host: str = "127.0.0.1"
    admin_port: int = 8792
    admin_enabled: bool = True
    allow_non_loopback: bool = False            # SDBOT_ALLOW_NON_LOOPBACK=1 is needed inside containers (0.0.0.0)
    data_dir: Path = ROOT / ".data"
    static_dir: Path = ROOT / "static"
    max_body_bytes: int = 25 * 1024 * 1024      # GitHub caps a delivery at 25 MB; larger bodies get 413
    repos: tuple[str, ...] = ()                 # optional owner/name allowlist; empty accepts every repo
    dedupe_window: int = 2000                   # remembered delivery ids for redelivery detection
    log_level: str = "INFO"
    secrets: dict[str, str] = field(default_factory=dict, repr=False)  # provider -> secret, memory only
    admin_token: str = field(default="", repr=False)                    # optional bearer token for the admin listener
    board_repo: str = ""
    board_track_repo: str = ""
    board_targets: dict[str, str] = field(default_factory=dict)  # GitHub source -> Pages repository
    board_source_dir: Path = ROOT.parent / "github_status_board"
    board_token: str = field(default="", repr=False)
    board_debounce: int = 20
    board_refresh: int = 3600

    @classmethod
    def from_env(cls, **overrides) -> "Config":
        cfg = cls(
            webhook_host=_str("SDBOT_WEBHOOK_HOST", cls.webhook_host, "SDBOT_HOST"),
            webhook_port=_int("SDBOT_WEBHOOK_PORT", cls.webhook_port, "SDBOT_PORT"),
            admin_host=_str("SDBOT_ADMIN_HOST", cls.admin_host),
            admin_port=_int("SDBOT_ADMIN_PORT", cls.admin_port),
            admin_enabled=_bool("SDBOT_ADMIN_ENABLED", True),
            allow_non_loopback=_bool("SDBOT_ALLOW_NON_LOOPBACK", False),
            max_body_bytes=_int("SDBOT_MAX_BODY_MB", 25) * 1024 * 1024,
            dedupe_window=_int("SDBOT_DEDUPE_WINDOW", cls.dedupe_window),
            log_level=os.environ.get("SDBOT_LOG_LEVEL", cls.log_level).upper(),
            admin_token=os.environ.get("SDBOT_ADMIN_TOKEN", "").strip(),
            board_repo=os.environ.get("SDBOT_BOARD_REPO", "").strip(),
            board_track_repo=os.environ.get("SDBOT_BOARD_TRACK_REPO", "").strip(),
            board_targets=json.loads(os.environ.get("SDBOT_BOARD_TARGETS") or "{}"),
            board_source_dir=Path(_str("SDBOT_BOARD_SOURCE_DIR", str(cls.board_source_dir))),
            board_token=os.environ.get("SDBOT_BOARD_GITHUB_TOKEN", "").strip(),
            board_debounce=_int("SDBOT_BOARD_DEBOUNCE", 20),
            board_refresh=_int("SDBOT_BOARD_REFRESH", 3600),
        )
        data = os.environ.get("SDBOT_DATA_DIR")
        if data:
            cfg.data_dir = Path(data).expanduser()
        repos = os.environ.get("SDBOT_REPOS") or ",".join(DEFAULT_REPOS)
        cfg.repos = tuple(r.strip().lower() for r in repos.split(",") if r.strip()) or DEFAULT_REPOS
        for provider, names in SECRET_ENV.items():
            for name in names:
                value = os.environ.get(name)
                if value:
                    cfg.secrets[provider] = value
                    break
        for key, value in overrides.items():
            if value is not None:
                setattr(cfg, key, value)
        return cfg

    def validate(self) -> list[str]:
        """Human-readable reasons the process must refuse to start (empty = fine)."""
        problems = []
        if self.board_repo or self.board_targets:
            targets = self.publication_targets()
            if not isinstance(targets, dict) or not all(isinstance(r, str) and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", r)
                                                       for pair in targets.items() for r in pair):
                problems.append("board targets must map source owner/name to Pages owner/name")
                targets = {}
            sources = [r.lower() for r in targets]
            destinations = [r.lower() for r in targets.values()]
            if len(set(sources)) != len(sources) or len(set(destinations)) != len(destinations):
                problems.append("board sources and destinations must each be unique")
            if set(sources) & set(destinations):
                problems.append("board destinations must not be tracked sources")
            if self.repos and any(not self.tracks(r, "github") for r in sources):
                problems.append("board sources must be included in SDBOT_REPOS")
            if self.board_targets and self.board_repo:
                problems.append("use board targets or legacy board repository, not both")
        if self.board_repo:
            if not all(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", r) for r in (self.board_repo, self.board_track_repo)):
                problems.append("board repositories must be owner/name")
        if self.board_repo or self.board_targets:
            if not self.board_token or not self.secret_for("github"):
                problems.append("board publishing requires a GitHub token and GitHub webhook secret")
            if not (self.board_source_dir / "publish.py").is_file():
                problems.append("board publisher script is missing")
            if self.board_debounce < 1 or self.board_refresh < 60:
                problems.append("board debounce must be >=1s and refresh >=60s")
        if self.max_body_bytes <= 0:
            problems.append("SDBOT_MAX_BODY_MB must be positive")
        if self.dedupe_window < 0:
            problems.append("SDBOT_DEDUPE_WINDOW must not be negative")
        for label, host in (("webhook", self.webhook_host), ("admin", self.admin_host)):
            if host not in LOOPBACK_HOSTS and not self.allow_non_loopback:
                problems.append(f"{label} listener on {host}: only loopback is allowed unless SDBOT_ALLOW_NON_LOOPBACK=1 (containers)")
        for label, port in (("webhook", self.webhook_port), ("admin", self.admin_port)):
            if port in RESERVED_PORTS:
                problems.append(f"{label} port {port} is reserved for the local trial stack")
        if self.admin_enabled and (self.admin_host, self.admin_port) == (self.webhook_host, self.webhook_port):
            problems.append("webhook and admin listeners must not share host:port")
        return problems

    def secret_for(self, provider: str) -> str | None:
        return self.secrets.get(provider) or None

    def publication_targets(self) -> dict[str, str]:
        return self.board_targets or ({self.board_track_repo: self.board_repo} if self.board_repo else {})

    def tracks(self, repo: str, provider: str = "github") -> bool:
        """A configured allowlist identifies GitHub repositories, never same-name GitCode repos."""
        return not self.repos or (provider == "github" and repo.lower() in {r.lower() for r in self.repos})

    def public(self) -> dict:
        """Admin status view: says which providers have a secret, never the secret itself."""
        return {
            "webhook": {"host": self.webhook_host, "port": self.webhook_port},
            "admin": {"host": self.admin_host, "port": self.admin_port, "token_required": bool(self.admin_token)},
            "data_dir": str(self.data_dir),
            "repos": list(self.repos),
            "store_payloads": True,
            "payload_max_bytes": self.max_body_bytes,
            "providers": {p: {"secret_configured": bool(self.secret_for(p))} for p in PROVIDERS},
        }
