"""The unified event model: adapters produce it, the router and the hooks consume it.

Vocabulary follows GitHub (``kind`` = webhook event family, ``action`` = the GitHub
action names). GitCode deliveries are mapped onto the same words, so a hook never has
to know which platform an event came from. A merged pull request always arrives as
``kind="pull_request", action="merged", merged=True`` regardless of whether the
platform reported it as ``closed`` + ``merged: true`` (GitHub) or ``action: merge``
(GitCode).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

KIND_PING = "ping"
KIND_ISSUE = "issue"
KIND_ISSUE_COMMENT = "issue_comment"
KIND_PULL_REQUEST = "pull_request"
KIND_PULL_REQUEST_REVIEW = "pull_request_review"
KIND_PUSH = "push"
KIND_INSTALLATION = "installation"
KIND_UNKNOWN = "unknown"

KNOWN_KINDS = (KIND_PING, KIND_ISSUE, KIND_ISSUE_COMMENT, KIND_PULL_REQUEST,
               KIND_PULL_REQUEST_REVIEW, KIND_PUSH, KIND_INSTALLATION)

ACTION_OPENED = "opened"
ACTION_EDITED = "edited"
ACTION_CLOSED = "closed"
ACTION_REOPENED = "reopened"
ACTION_LABELED = "labeled"
ACTION_UNLABELED = "unlabeled"
ACTION_ASSIGNED = "assigned"
ACTION_UNASSIGNED = "unassigned"
ACTION_SYNCHRONIZE = "synchronize"
ACTION_MERGED = "merged"
ACTION_CREATED = "created"
ACTION_SUBMITTED = "submitted"
ACTION_PUSHED = "pushed"


@dataclass
class Event:
    provider: str                  # github | gitcode
    delivery_id: str               # X-GitHub-Delivery / X-GitCode-Delivery (or payload uuid)
    kind: str                      # one of KIND_*
    action: str                    # normalised action, e.g. opened / merged / pushed
    repo: str = ""                 # owner/name
    number: int | None = None      # issue / PR number (GitCode iid)
    title: str = ""
    url: str = ""
    sender: str = ""               # login of the user who triggered the delivery
    merged: bool = False           # True only for a merged pull request
    labels: list[str] = field(default_factory=list)
    ref: str = ""                  # push: refs/heads/...
    raw_event: str = ""            # header value as sent by the platform
    raw_action: str = ""           # action string as sent by the platform
    extra: dict = field(default_factory=dict)   # small provider details (state, branches, comment id ...)
    payload: dict = field(default_factory=dict, repr=False, compare=False)

    @property
    def route(self) -> str:
        """Dispatch key, e.g. ``pull_request.merged`` or ``unknown.star``."""
        if self.kind == KIND_UNKNOWN:
            return f"{KIND_UNKNOWN}.{self.raw_event or '?'}"
        return f"{self.kind}.{self.action}" if self.action else self.kind

    def summary(self) -> dict:
        """Everything except the raw payload; this is what goes into the event log."""
        data = asdict(self)
        data.pop("payload", None)
        data["route"] = self.route
        return data
