"""GitHub App, organization and repository webhook payloads -> unified Event.

Reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads
Headers: X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256,
X-GitHub-Hook-Installation-Target-Type / -ID (integration, organization, repository).
Target headers and payload.installation are optional metadata, never prerequisites.
"""

from __future__ import annotations

from ..events import (ACTION_MERGED, ACTION_PUSHED, KIND_INSTALLATION, KIND_ISSUE, KIND_ISSUE_COMMENT,
                      KIND_PING, KIND_PULL_REQUEST, KIND_PULL_REQUEST_REVIEW, KIND_PUSH, KIND_UNKNOWN, Event)
from ..signature import header

EVENT_HEADER = "X-GitHub-Event"
DELIVERY_HEADER = "X-GitHub-Delivery"

KIND_BY_EVENT = {
    "ping": KIND_PING,
    "issues": KIND_ISSUE,
    "issue_comment": KIND_ISSUE_COMMENT,
    "pull_request": KIND_PULL_REQUEST,
    "pull_request_review": KIND_PULL_REQUEST_REVIEW,
    "pull_request_review_comment": KIND_PULL_REQUEST_REVIEW,   # diff comments join the review family
    "push": KIND_PUSH,
    "installation": KIND_INSTALLATION,
    "installation_repositories": KIND_INSTALLATION,
}


def _login(obj) -> str:
    return (obj or {}).get("login") or ""


def _fill_item(event: Event, item: dict) -> None:
    """Shared issue / pull request fields."""
    event.number = item.get("number")
    event.title = item.get("title") or ""
    event.url = item.get("html_url") or ""
    event.labels = [l.get("name") for l in item.get("labels") or [] if isinstance(l, dict) and l.get("name")]
    event.extra["state"] = item.get("state")
    event.extra["author"] = _login(item.get("user"))
    event.extra["assignees"] = [_login(a) for a in item.get("assignees") or [] if _login(a)]


def normalize(headers, payload: dict) -> Event:
    raw_event = header(headers, EVENT_HEADER) or ""
    raw_action = str(payload.get("action") or "")
    kind = KIND_BY_EVENT.get(raw_event, KIND_UNKNOWN)
    event = Event(
        provider="github",
        delivery_id=header(headers, DELIVERY_HEADER) or "",
        kind=kind,
        action=raw_action,
        repo=(payload.get("repository") or {}).get("full_name") or "",
        sender=_login(payload.get("sender")),
        raw_event=raw_event,
        raw_action=raw_action,
        payload=payload,
    )
    target_type = header(headers, "X-GitHub-Hook-Installation-Target-Type")
    if target_type:
        event.extra["hook_target"] = f"{target_type}:{header(headers, 'X-GitHub-Hook-Installation-Target-ID') or ''}"
    if payload.get("installation"):
        event.extra["installation_id"] = (payload.get("installation") or {}).get("id")

    if kind == KIND_PING:
        hook = payload.get("hook") or {}
        event.action = "ping"
        event.extra.update(zen=payload.get("zen"), hook_id=payload.get("hook_id"),
                           hook_type=hook.get("type"), hook_events=hook.get("events"))
    elif kind == KIND_ISSUE:
        _fill_item(event, payload.get("issue") or {})
        if payload.get("label"):
            event.extra["label"] = (payload.get("label") or {}).get("name")
        if payload.get("assignee"):
            event.extra["assignee"] = _login(payload.get("assignee"))
    elif kind == KIND_ISSUE_COMMENT:
        issue = payload.get("issue") or {}
        _fill_item(event, issue)
        comment = payload.get("comment") or {}
        event.extra.update(on="pull_request" if issue.get("pull_request") else "issue",
                           comment_id=comment.get("id"), comment_url=comment.get("html_url"),
                           comment_author=_login(comment.get("user")))
    elif kind == KIND_PULL_REQUEST:
        pr = payload.get("pull_request") or {}
        _fill_item(event, pr)
        event.extra.update(draft=bool(pr.get("draft")), head=(pr.get("head") or {}).get("ref"),
                           head_sha=(pr.get("head") or {}).get("sha"), base=(pr.get("base") or {}).get("ref"),
                           merged_at=pr.get("merged_at"), merge_commit_sha=pr.get("merge_commit_sha"),
                           merged_by=_login(pr.get("merged_by")))
        # GitHub reports a merge as "closed" with merged=true; surface it as its own action.
        event.merged = bool(pr.get("merged")) or bool(pr.get("merged_at"))
        if raw_action == "closed" and event.merged:
            event.action = ACTION_MERGED
        if payload.get("label"):
            event.extra["label"] = (payload.get("label") or {}).get("name")
        if raw_action == "synchronize":
            event.extra.update(before=payload.get("before"), after=payload.get("after"))
    elif kind == KIND_PULL_REQUEST_REVIEW:
        _fill_item(event, payload.get("pull_request") or {})
        review = payload.get("review") or payload.get("comment") or {}
        event.extra.update(on="diff_comment" if raw_event == "pull_request_review_comment" else "review",
                           review_id=review.get("id"), review_state=review.get("state"),
                           review_url=review.get("html_url"), review_author=_login(review.get("user")))
    elif kind == KIND_PUSH:
        event.action = ACTION_PUSHED
        event.ref = payload.get("ref") or ""
        event.extra.update(before=payload.get("before"), after=payload.get("after"),
                           commits=len(payload.get("commits") or []), forced=bool(payload.get("forced")),
                           created=bool(payload.get("created")), deleted=bool(payload.get("deleted")),
                           pusher=(payload.get("pusher") or {}).get("name"))
    elif kind == KIND_INSTALLATION:
        inst = payload.get("installation") or {}
        repos = payload.get("repositories") or payload.get("repositories_added") or []
        event.extra.update(account=_login(inst.get("account")), app_id=inst.get("app_id"),
                           repositories=[r.get("full_name") for r in repos if isinstance(r, dict)],
                           repositories_removed=[r.get("full_name") for r in payload.get("repositories_removed") or []])
    return event
