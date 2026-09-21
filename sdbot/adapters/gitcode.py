"""GitCode repository webhook payloads -> unified Event.

Reference: https://docs.gitcode.com/docs/help/home/org_project/webhook/web-hook/ and the
per-event pages under webhook-stepup/ (commit / issue / merge-request / tag-push / note).
Headers: X-GitCode-Event ("Push Hook", "Tag Push Hook", "Issue Hook", "Merge Request Hook",
"Note Hook"), X-GitCode-Delivery, and X-GitCode-Signature-256 or X-GitCode-Token.
Payloads are GitLab-shaped: object_kind / event_type, object_attributes{iid, action,
state}, project.path_with_namespace, user, labels. GitCode has no ``ping``: the
"test" button on the webhook page sends a regular event instead.
"""

from __future__ import annotations

from ..events import (ACTION_CLOSED, ACTION_CREATED, ACTION_EDITED, ACTION_MERGED, ACTION_OPENED, ACTION_PUSHED,
                      ACTION_REOPENED, ACTION_SYNCHRONIZE, KIND_ISSUE, KIND_ISSUE_COMMENT, KIND_PULL_REQUEST,
                      KIND_PUSH, KIND_UNKNOWN, Event)
from ..signature import header

EVENT_HEADER = "X-GitCode-Event"
DELIVERY_HEADER = "X-GitCode-Delivery"

KIND_BY_EVENT = {
    "Issue Hook": KIND_ISSUE,
    "Merge Request Hook": KIND_PULL_REQUEST,
    "Note Hook": KIND_ISSUE_COMMENT,
    "Push Hook": KIND_PUSH,
    "Tag Push Hook": KIND_PUSH,
}
KIND_BY_OBJECT = {"issue": KIND_ISSUE, "merge_request": KIND_PULL_REQUEST, "note": KIND_ISSUE_COMMENT,
                  "push": KIND_PUSH, "tag_push": KIND_PUSH}
# object_attributes.action -> GitHub vocabulary
ACTION_MAP = {"open": ACTION_OPENED, "close": ACTION_CLOSED, "reopen": ACTION_REOPENED,
              "update": ACTION_EDITED, "merge": ACTION_MERGED}


def _user(obj) -> str:
    obj = obj or {}
    return obj.get("username") or obj.get("name") or ""


def _labels(payload: dict) -> list[str]:
    out = []
    for label in payload.get("labels") or []:
        if isinstance(label, dict):
            name = label.get("title") or label.get("name")
        else:
            name = str(label)
        if name:
            out.append(name)
    return out


def normalize(headers, payload: dict) -> Event:
    raw_event = header(headers, EVENT_HEADER) or ""
    attrs = payload.get("object_attributes") or {}
    raw_action = str(attrs.get("action") or "")
    kind = KIND_BY_EVENT.get(raw_event) or KIND_BY_OBJECT.get(str(payload.get("object_kind") or "")) or KIND_UNKNOWN
    project = payload.get("project") or {}
    event = Event(
        provider="gitcode",
        delivery_id=header(headers, DELIVERY_HEADER) or payload.get("uuid") or payload.get("produce_random_id") or "",
        kind=kind,
        action=ACTION_MAP.get(raw_action, raw_action),
        repo=project.get("path_with_namespace") or "",
        sender=_user(payload.get("user")) or payload.get("user_username") or "",
        raw_event=raw_event or str(payload.get("object_kind") or ""),
        raw_action=raw_action,
        payload=payload,
    )
    event.extra["uuid"] = payload.get("uuid")
    changes = payload.get("changes")
    if isinstance(changes, dict) and changes:
        event.extra["changed_fields"] = sorted(changes.keys())

    if kind == KIND_ISSUE:
        event.number = attrs.get("iid")
        event.title = attrs.get("title") or ""
        event.url = attrs.get("url") or ""
        event.labels = _labels(payload)
        event.extra.update(state=attrs.get("state"), author=_user(attrs.get("author")),
                           assignee_ids=attrs.get("assignee_ids") or [], confidential=bool(attrs.get("confidential")))
    elif kind == KIND_PULL_REQUEST:
        event.number = attrs.get("iid")
        event.title = attrs.get("title") or ""
        event.url = attrs.get("url") or ""
        event.labels = _labels(payload)
        state = attrs.get("state")
        last_commit = attrs.get("last_commit") or {}
        event.extra.update(state=state, author=_user(attrs.get("author")), head=attrs.get("source_branch"),
                           base=attrs.get("target_branch"), head_sha=last_commit.get("id"),
                           merge_status=attrs.get("merge_status"), draft=bool(attrs.get("work_in_progress")),
                           source_project_id=attrs.get("source_project_id"), target_project_id=attrs.get("target_project_id"),
                           reviewers=[_user(r) for r in attrs.get("reviewer_list") or [] if isinstance(r, dict)],
                           assignees=[_user(a) for a in attrs.get("assignee_list") or [] if isinstance(a, dict)])
        # GitLab-style "update" with oldrev set means new commits were pushed to the source branch.
        if raw_action == "update" and attrs.get("oldrev"):
            event.action = ACTION_SYNCHRONIZE
            event.extra["before"] = attrs.get("oldrev")
        event.merged = raw_action == "merge" or state == "merged"
        if event.merged:
            event.action = ACTION_MERGED
    elif kind == KIND_ISSUE_COMMENT:
        noteable = str(attrs.get("noteable_type") or "")
        if noteable == "MergeRequest":
            item, on = payload.get("merge_request") or {}, "pull_request"
        elif noteable == "Issue":
            item, on = payload.get("issue") or {}, "issue"
        else:
            item, on = payload.get("commit") or {}, noteable.lower() or "unknown"
        event.action = ACTION_CREATED
        event.number = item.get("iid")
        event.title = item.get("title") or ""
        event.url = item.get("url") or ""
        event.extra.update(on=on, comment_id=attrs.get("id"), comment_url=attrs.get("url"),
                           comment_author=event.sender, system=bool(attrs.get("system")),
                           state=item.get("state"), commit_id=item.get("id") if on == "commit" else None)
    elif kind == KIND_PUSH:
        event.action = ACTION_PUSHED
        event.ref = payload.get("ref") or ""
        event.extra.update(before=payload.get("before"), after=payload.get("after"),
                           commits=len(payload.get("commits") or []), total_commits=payload.get("total_commits_count"),
                           branch=payload.get("git_branch"), tag=raw_event == "Tag Push Hook" or payload.get("object_kind") == "tag_push")
    return event
