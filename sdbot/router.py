"""Protocol normalization and compatibility facade over the subscription bus."""
from dataclasses import replace

from .bus import EventBus, Outcome
from .events import ACTION_MERGED, KIND_INSTALLATION, KIND_PING, KIND_PULL_REQUEST
from .hooks import AnalyzeHandler, BoardUpdater
from .subscriptions import register_builtin_listeners


class Router:
    def __init__(self, analyze=None, board=None, log=None):
        self.analyze = analyze or AnalyzeHandler()
        self.board = board or BoardUpdater()
        self.bus = EventBus(log)
        register_builtin_listeners(self.bus, self.analyze, self.board)

    def knows(self, kind: str) -> bool:
        return kind in (KIND_PING, KIND_INSTALLATION) or any(
            route.split(".", 1)[0] in (kind, "*")
            for listener in self.bus.inventory() if listener["enabled"] for route in listener["routes"])

    def dispatch(self, event) -> Outcome:
        if event.kind == KIND_PULL_REQUEST and event.merged and event.action != ACTION_MERGED:
            event = replace(event, action=ACTION_MERGED)
        # Handshakes and installation notices never trigger business listeners.
        if event.kind == KIND_PING:
            return Outcome(True, event.route, note="pong")
        if event.kind == KIND_INSTALLATION:
            return Outcome(True, event.route, note="installation change recorded; no business listeners")
        outcome = self.bus.dispatch(event)
        if not outcome.handled:
            outcome.note = "no matching listener, recorded only"
        return outcome
