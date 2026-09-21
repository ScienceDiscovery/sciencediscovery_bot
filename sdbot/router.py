"""Routes unified events to the built-in per-kind handlers, which call the hooks.

Only the *kind* decides the handler; the handler then looks at the action to decide which
hooks are relevant. A merged pull request is split off into its own handler
(``on_pull_request_merged``) so later phases can treat merges independently of other
PR updates. Unknown kinds are recorded by the caller and never reach a hook.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .events import (ACTION_EDITED, ACTION_MERGED, ACTION_OPENED, ACTION_REOPENED, ACTION_SYNCHRONIZE, KIND_INSTALLATION,
                     KIND_ISSUE, KIND_ISSUE_COMMENT, KIND_PING, KIND_PULL_REQUEST, KIND_PULL_REQUEST_REVIEW, KIND_PUSH, Event)
from .hooks import AnalyzeHandler, BoardUpdater

# Actions on which the analysis hook is worth waking up; everything else only touches the board.
ANALYZE_ISSUE_ACTIONS = (ACTION_OPENED, ACTION_EDITED, ACTION_REOPENED)
ANALYZE_PR_ACTIONS = (ACTION_OPENED, ACTION_SYNCHRONIZE, ACTION_REOPENED, ACTION_EDITED, "ready_for_review")


@dataclass
class Outcome:
    handled: bool                       # False for unknown kinds and redeliveries
    route: str                          # e.g. pull_request.merged
    hooks: list[dict] = field(default_factory=list)     # results returned by hook methods
    errors: list[str] = field(default_factory=list)     # hook / handler exceptions, already logged
    duplicate: bool = False
    note: str = ""

    def hook_names(self) -> list[str]:
        return [f"{h.get('hook')}.{h.get('method')}" for h in self.hooks]


class Router:
    def __init__(self, analyze: AnalyzeHandler | None = None, board: BoardUpdater | None = None,
                 log: logging.Logger | None = None):
        self.analyze = analyze or AnalyzeHandler()
        self.board = board or BoardUpdater()
        self.log = log or logging.getLogger("sdbot.router")
        self._handlers = {
            KIND_PING: self.on_ping,
            KIND_ISSUE: self.on_issue,
            KIND_ISSUE_COMMENT: self.on_issue_comment,
            KIND_PULL_REQUEST: self.on_pull_request,
            KIND_PULL_REQUEST_REVIEW: self.on_pull_request_review,
            KIND_PUSH: self.on_push,
            KIND_INSTALLATION: self.on_installation,
        }
        for kind in ("workflow_run", "workflow_job", "check_run", "check_suite", "status", "release", "create", "delete"):
            self._handlers[kind] = self.on_quality

    def knows(self, kind: str) -> bool:
        return kind in self._handlers

    def dispatch(self, event: Event) -> Outcome:
        handler = self._handlers.get(event.kind)
        if handler is None:
            return Outcome(False, event.route, note="unknown event kind, recorded only")
        outcome = Outcome(True, event.route)
        try:
            handler(event, outcome)
        except Exception as err:  # a handler bug must never turn into a 5xx for the sender
            self.log.exception("handler for %s failed", event.route)
            outcome.errors.append(f"{event.kind}: {type(err).__name__}: {err}")
        return outcome

    def _call(self, outcome: Outcome, hook_method, event: Event) -> None:
        try:
            result = hook_method(event)
        except Exception as err:
            self.log.exception("hook %s failed on %s", getattr(hook_method, "__qualname__", hook_method), event.route)
            outcome.errors.append(f"{getattr(hook_method, '__qualname__', 'hook')}: {type(err).__name__}: {err}")
            return
        if result:
            outcome.hooks.append(result)

    # ---------------------------------------------------------------- handlers
    def on_ping(self, event: Event, outcome: Outcome) -> None:
        outcome.note = "pong"

    def on_issue(self, event: Event, outcome: Outcome) -> None:
        if event.action in ANALYZE_ISSUE_ACTIONS:
            self._call(outcome, self.analyze.on_issue, event)
        self._call(outcome, self.board.on_issue, event)

    def on_issue_comment(self, event: Event, outcome: Outcome) -> None:
        self._call(outcome, self.analyze.on_issue_comment, event)
        self._call(outcome, self.board.on_issue_comment, event)

    def on_pull_request(self, event: Event, outcome: Outcome) -> None:
        if event.merged or event.action == ACTION_MERGED:
            return self.on_pull_request_merged(event, outcome)
        if event.action in ANALYZE_PR_ACTIONS:
            self._call(outcome, self.analyze.on_pull_request, event)
        self._call(outcome, self.board.on_pull_request, event)

    def on_pull_request_merged(self, event: Event, outcome: Outcome) -> None:
        outcome.route = f"{KIND_PULL_REQUEST}.{ACTION_MERGED}"
        self._call(outcome, self.analyze.on_pull_request_merged, event)
        self._call(outcome, self.board.on_pull_request_merged, event)

    def on_pull_request_review(self, event: Event, outcome: Outcome) -> None:
        self._call(outcome, self.analyze.on_pull_request_review, event)
        self._call(outcome, self.board.on_pull_request, event)

    def on_push(self, event: Event, outcome: Outcome) -> None:
        self._call(outcome, self.board.on_push, event)

    def on_quality(self, event: Event, outcome: Outcome) -> None:
        self._call(outcome, self.board.on_quality, event)

    def on_installation(self, event: Event, outcome: Outcome) -> None:
        outcome.note = "installation change recorded; no hook subscribed"
