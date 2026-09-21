"""Extension points that later phases fill in.

Every method is a no-op today, but the router already calls them on the right events,
so an implementation can be dropped in without touching the pipeline. Each call is
appended to ``calls`` and returned as a small dict that ends up in the event log, which
is how the wiring is verified now (tests + ``hooks`` column of events.jsonl).

Rules for future implementations: never raise for a business failure (log and return a
dict with ``status: "error"``); never block the webhook thread for long (queue heavy work
and return); the router already catches exceptions so a bug cannot turn into a 5xx.
"""

from __future__ import annotations

import logging

from .events import Event


class Hook:
    name = "hook"

    def __init__(self, log: logging.Logger | None = None):
        self.calls: list[tuple[str, str]] = []           # (method, delivery_id), newest last
        self.log = log or logging.getLogger(f"sdbot.hooks.{self.name}")

    def _noop(self, method: str, event: Event) -> dict:
        self.calls.append((method, event.delivery_id))
        if len(self.calls) > 500:
            del self.calls[:-500]
        self.log.info("%s.%s noop route=%s repo=%s number=%s", self.name, method, event.route, event.repo, event.number)
        return {"hook": self.name, "method": method, "status": "noop"}


class AnalyzeHandler(Hook):
    """Future: automatic Issue / PR analysis and review.

    Planned (not implemented, nothing here may post to GitHub/GitCode yet):
      - on_issue (opened/edited/reopened): classify, look for duplicates, draft a triage note
      - on_issue_comment: slash-command entry point (e.g. ``/analyze``) for humans to ask for a review
      - on_pull_request (opened/synchronize/reopened/ready_for_review): review summary of the diff
      - on_pull_request_review: fold reviewer verdicts into the PR record
      - on_pull_request_merged: post-merge summary / changelog material
    """

    name = "analyze"

    def on_issue(self, event: Event) -> dict:
        return self._noop("on_issue", event)

    def on_issue_comment(self, event: Event) -> dict:
        return self._noop("on_issue_comment", event)

    def on_pull_request(self, event: Event) -> dict:
        return self._noop("on_pull_request", event)

    def on_pull_request_review(self, event: Event) -> dict:
        return self._noop("on_pull_request_review", event)

    def on_pull_request_merged(self, event: Event) -> dict:
        return self._noop("on_pull_request_merged", event)


class BoardUpdater(Hook):
    """Future: board updates driven by App or ordinary webhook events.

    Downstream integrations can enqueue a debounced refresh after issue, pull request,
    or push events. This framework only records calls; no external board is contacted.
    """

    name = "board"

    def on_issue(self, event: Event) -> dict:
        return self._noop("on_issue", event)

    def on_issue_comment(self, event: Event) -> dict:
        return self._noop("on_issue_comment", event)

    def on_pull_request(self, event: Event) -> dict:
        return self._noop("on_pull_request", event)

    def on_pull_request_merged(self, event: Event) -> dict:
        return self._noop("on_pull_request_merged", event)

    def on_push(self, event: Event) -> dict:
        return self._noop("on_push", event)

    def on_quality(self, event: Event) -> dict:
        return self._noop("on_quality", event)
