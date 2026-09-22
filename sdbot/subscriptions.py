"""Composition root for built-in businesses. Add independent subscriptions here."""
from .bus import Listener


def register_builtin_listeners(bus, analyze, board):
    def add(hook, method, business, description, routes, *, exclude=()):
        if hook.mode != "noop":
            description = description.replace("；当前仅记录调用。", "。")
        bus.subscribe(Listener(f"{hook.name}.{method}", business, description, tuple(routes),
                               getattr(hook, method), exclude=exclude, mode=hook.mode,
                               providers=getattr(hook, "listener_providers", ()),
                               repositories=getattr(hook, "listener_repositories", ())))

    add(analyze, "on_issue", "内容分析", "Issue 新建、编辑和重新打开的分析入口；当前仅记录调用。",
        ("issue.opened", "issue.edited", "issue.reopened"))
    add(analyze, "on_issue_comment", "内容分析", "Issue / PR 评论分析入口；当前仅记录调用。", ("issue_comment", "issue_comment.*"))
    add(analyze, "on_pull_request", "内容分析", "PR 变更分析入口；当前仅记录调用。",
        tuple(f"pull_request.{a}" for a in ("opened", "synchronize", "reopened", "edited", "ready_for_review")))
    add(analyze, "on_pull_request_review", "内容分析", "PR 评审和行内评论入口；当前仅记录调用。", ("pull_request_review", "pull_request_review.*"))
    add(analyze, "on_pull_request_merged", "内容分析", "PR 合并后的分析入口；当前仅记录调用。", ("pull_request.merged",))

    description = "按源仓排队更新对应静态看板。" if board.mode == "active" else "未启用静态发布，当前仅记录调用。"
    for method, routes, exclude in (
        ("on_issue", ("issue", "issue.*"), ()),
        ("on_issue_comment", ("issue_comment", "issue_comment.*"), ()),
        ("on_pull_request", ("pull_request", "pull_request.*", "pull_request_review", "pull_request_review.*"), ("pull_request.merged",)),
        ("on_pull_request_merged", ("pull_request.merged",), ()),
        ("on_push", ("push", "push.*"), ()),
        ("on_quality", tuple(route for kind in ("workflow_run", "workflow_job", "check_run", "check_suite", "status", "release", "create", "delete")
                             for route in (kind, kind + ".*")), ()),
    ):
        add(board, method, "看板更新", description, routes, exclude=exclude)
