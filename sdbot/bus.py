"""In-process event bus; registered subscriptions are also the admin inventory."""
from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatchcase
import logging
import threading
from typing import Callable

from .events import Event


@dataclass
class Outcome:
    handled: bool
    route: str
    hooks: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    duplicate: bool = False
    note: str = ""
    listeners: list[dict] = field(default_factory=list)

    def hook_names(self) -> list[str]:
        return [f"{h.get('hook')}.{h.get('method')}" for h in self.hooks]


@dataclass(frozen=True)
class Listener:
    id: str
    business: str
    description: str
    routes: tuple[str, ...]
    handler: Callable[[Event], dict | None] = field(repr=False, compare=False)
    exclude: tuple[str, ...] = ()
    providers: tuple[str, ...] = ()
    repositories: tuple[str, ...] = ()
    enabled: bool = True
    mode: str = "active"

    def matches(self, event: Event) -> bool:
        return (self.enabled
                and any(fnmatchcase(event.route, pattern) for pattern in self.routes)
                and not any(fnmatchcase(event.route, pattern) for pattern in self.exclude)
                and (not self.providers or event.provider in self.providers)
                and (not self.repositories or event.repo.lower() in {r.lower() for r in self.repositories}))

    def public(self) -> dict:
        return {"id": self.id, "business": self.business, "description": self.description,
                "routes": list(self.routes), "exclude": list(self.exclude), "providers": list(self.providers),
                "repositories": list(self.repositories), "enabled": self.enabled,
                "mode": self.mode if self.enabled else "disabled"}


class EventBus:
    def __init__(self, log=None):
        self.log = log or logging.getLogger("sdbot.bus")
        self._listeners: dict[str, Listener] = {}
        self._lock = threading.RLock()

    def subscribe(self, listener: Listener) -> None:
        if not all(isinstance(v, str) and v.strip() for v in (listener.id, listener.business, listener.description)) or not listener.routes:
            raise ValueError("listener requires an id, business, description and routes")
        if not callable(listener.handler) or listener.mode not in ("active", "noop"):
            raise ValueError("invalid listener handler or mode")
        for selectors in (listener.routes, listener.exclude, listener.providers, listener.repositories):
            if not isinstance(selectors, tuple) or any(not isinstance(v, str) or not v for v in selectors):
                raise ValueError("listener selectors must be tuples of non-empty strings")
        with self._lock:
            if listener.id in self._listeners:
                raise ValueError("duplicate listener id")
            self._listeners[listener.id] = listener

    def inventory(self) -> list[dict]:
        with self._lock:
            return [listener.public() for listener in self._listeners.values()]

    def dispatch(self, event: Event) -> Outcome:
        with self._lock:
            listeners = [listener for listener in self._listeners.values() if listener.matches(event)]
        outcome = Outcome(bool(listeners), event.route)
        for listener in listeners:
            try:
                result = listener.handler(event)
                if result is not None and not isinstance(result, dict):
                    raise TypeError("listener must return a dict or None")
                if result and result.get("hook") and result.get("method"):
                    outcome.hooks.append(result)
                outcome.listeners.append({"id": listener.id, "status": str((result or {}).get("status", "ok"))})
            except Exception as err:
                # Exceptions may contain credentials or payloads. Retain only the category.
                category = type(err).__name__
                outcome.errors.append(f"{listener.id}: {category}")
                outcome.listeners.append({"id": listener.id, "status": "error", "error": category})
                self.log.warning("listener %s failed (%s)", listener.id, category)
        return outcome
