import unittest

from tests.helpers import fixture, signed
from sdbot.adapters import detect_provider, normalize
from sdbot.hooks import AnalyzeHandler, BoardUpdater
from sdbot.router import Router

# route -> hooks the router must call, in order
EXPECTED_HOOKS = {
    "github/ping": [],
    "github/installation_created": [],
    "github/issues_opened": ["analyze.on_issue", "board.on_issue"],
    "github/issues_labeled": ["board.on_issue"],
    "github/issues_assigned": ["board.on_issue"],
    "github/issues_closed": ["board.on_issue"],
    "github/issue_comment_created": ["analyze.on_issue_comment", "board.on_issue_comment"],
    "github/pull_request_opened": ["analyze.on_pull_request", "board.on_pull_request"],
    "github/pull_request_synchronize": ["analyze.on_pull_request", "board.on_pull_request"],
    "github/pull_request_review_submitted": ["analyze.on_pull_request_review", "board.on_pull_request"],
    "github/pull_request_closed_unmerged": ["board.on_pull_request"],
    "github/pull_request_closed_merged": ["analyze.on_pull_request_merged", "board.on_pull_request_merged"],
    "github/push": ["board.on_push"],
    "gitcode/issue_open": ["analyze.on_issue", "board.on_issue"],
    "gitcode/issue_close": ["board.on_issue"],
    "gitcode/merge_request_open": ["analyze.on_pull_request", "board.on_pull_request"],
    "gitcode/merge_request_update": ["analyze.on_pull_request", "board.on_pull_request"],
    "gitcode/merge_request_merge": ["analyze.on_pull_request_merged", "board.on_pull_request_merged"],
    "gitcode/merge_request_close": ["board.on_pull_request"],
    "gitcode/note_issue": ["analyze.on_issue_comment", "board.on_issue_comment"],
    "gitcode/note_merge_request": ["analyze.on_issue_comment", "board.on_issue_comment"],
    "gitcode/push": ["board.on_push"],
}


def event_for(name):
    headers, _ = signed(name, fresh_delivery=False)
    return normalize(detect_provider(headers), headers, fixture(name)["payload"])


class RouterTests(unittest.TestCase):
    def test_hooks_called_per_route(self):
        for name, hooks in EXPECTED_HOOKS.items():
            with self.subTest(fixture=name):
                router = Router()
                outcome = router.dispatch(event_for(name))
                self.assertTrue(outcome.handled)
                self.assertEqual(outcome.hook_names(), hooks)
                self.assertEqual(outcome.errors, [])
                called = [f"{h.name}.{m}" for h in (router.analyze, router.board) for m, _ in h.calls]
                self.assertEqual(sorted(called), sorted(hooks))

    def test_merge_gets_its_own_route_from_both_platforms(self):
        for name in ("github/pull_request_closed_merged", "gitcode/merge_request_merge"):
            with self.subTest(fixture=name):
                outcome = Router().dispatch(event_for(name))
                self.assertEqual(outcome.route, "pull_request.merged")

    def test_unknown_kind_is_not_routed(self):
        router = Router()
        outcome = router.dispatch(event_for("github/unknown_star"))
        self.assertFalse(outcome.handled)
        self.assertEqual(outcome.route, "unknown.star")
        self.assertEqual(router.analyze.calls + router.board.calls, [])

    def test_hooks_are_noop_and_report_it(self):
        outcome = Router().dispatch(event_for("github/issues_opened"))
        self.assertEqual({h["status"] for h in outcome.hooks}, {"noop"})

    def test_hook_exception_is_contained(self):
        class Broken(AnalyzeHandler):
            def on_issue(self, event):
                raise RuntimeError("boom")

        router = Router(analyze=Broken(), board=BoardUpdater())
        outcome = router.dispatch(event_for("github/issues_opened"))
        self.assertTrue(outcome.handled)
        self.assertEqual(outcome.hook_names(), ["board.on_issue"])   # the other hook still ran
        self.assertEqual(len(outcome.errors), 1)
        self.assertIn("boom", outcome.errors[0])

    def test_custom_hooks_receive_the_unified_event(self):
        seen = []

        class Recording(BoardUpdater):
            def on_pull_request_merged(self, event):
                seen.append((event.provider, event.number, event.merged))
                return {"hook": "board", "method": "on_pull_request_merged", "status": "ok"}

        Router(board=Recording()).dispatch(event_for("gitcode/merge_request_merge"))
        Router(board=Recording()).dispatch(event_for("github/pull_request_closed_merged"))
        self.assertEqual(seen, [("gitcode", 27, True), ("github", 51, True)])


if __name__ == "__main__":
    unittest.main()
