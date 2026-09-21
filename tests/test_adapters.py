import unittest

from tests.helpers import all_fixture_names, fixture, signed
from sdbot.adapters import detect_provider, normalize
from sdbot.adapters import gitcode as gitcode_adapter

GH = "openJiuwen-ai/sciencediscovery"
GC = "openJiuwen/sciencediscovery"

# fixture -> (kind, action, number, repo, merged)
EXPECTED = {
    "github/ping": ("ping", "ping", None, "", False),
    "github/installation_created": ("installation", "created", None, "", False),
    "github/issues_opened": ("issue", "opened", 68, GH, False),
    "github/issues_labeled": ("issue", "labeled", 68, GH, False),
    "github/issues_assigned": ("issue", "assigned", 68, GH, False),
    "github/issues_closed": ("issue", "closed", 68, GH, False),
    "github/issue_comment_created": ("issue_comment", "created", 68, GH, False),
    "github/pull_request_opened": ("pull_request", "opened", 51, GH, False),
    "github/pull_request_synchronize": ("pull_request", "synchronize", 51, GH, False),
    "github/pull_request_review_submitted": ("pull_request_review", "submitted", 51, GH, False),
    "github/pull_request_closed_unmerged": ("pull_request", "closed", 52, GH, False),
    "github/pull_request_closed_merged": ("pull_request", "merged", 51, GH, True),
    "github/push": ("push", "pushed", None, GH, False),
    "github/unknown_star": ("unknown", "created", None, GH, False),
    "gitcode/issue_open": ("issue", "opened", 123, GC, False),
    "gitcode/issue_close": ("issue", "closed", 123, GC, False),
    "gitcode/merge_request_open": ("pull_request", "opened", 27, GC, False),
    "gitcode/merge_request_update": ("pull_request", "synchronize", 27, GC, False),
    "gitcode/merge_request_merge": ("pull_request", "merged", 27, GC, True),
    "gitcode/merge_request_close": ("pull_request", "closed", 28, GC, False),
    "gitcode/note_issue": ("issue_comment", "created", 123, GC, False),
    "gitcode/note_merge_request": ("issue_comment", "created", 27, GC, False),
    "gitcode/push": ("push", "pushed", None, GC, False),
}


def normalized(name: str):
    headers, _ = signed(name, fresh_delivery=False)
    return normalize(detect_provider(headers), headers, fixture(name)["payload"])


class FixtureCoverageTests(unittest.TestCase):
    def test_every_fixture_has_an_expectation(self):
        self.assertEqual(sorted(EXPECTED), all_fixture_names())

    def test_normalisation_table(self):
        for name, (kind, action, number, repo, merged) in EXPECTED.items():
            with self.subTest(fixture=name):
                ev = normalized(name)
                self.assertEqual((ev.kind, ev.action, ev.number, ev.repo, ev.merged), (kind, action, number, repo, merged))
                self.assertEqual(ev.provider, name.split("/")[0])
                self.assertEqual(ev.delivery_id, fixture(name)["delivery"])
                self.assertNotIn("payload", ev.summary())


class GitHubDetailTests(unittest.TestCase):
    def test_merged_pr_keeps_raw_action_and_merge_details(self):
        ev = normalized("github/pull_request_closed_merged")
        self.assertEqual(ev.raw_action, "closed")
        self.assertEqual(ev.route, "pull_request.merged")
        self.assertEqual(ev.extra["merged_by"], "alice")
        self.assertTrue(ev.extra["merge_commit_sha"])

    def test_unmerged_close_is_not_a_merge(self):
        ev = normalized("github/pull_request_closed_unmerged")
        self.assertEqual(ev.route, "pull_request.closed")
        self.assertFalse(ev.merged)

    def test_issue_fields(self):
        ev = normalized("github/issues_labeled")
        self.assertEqual(ev.labels, ["bug", "priority/P1"])
        self.assertEqual(ev.extra["label"], "priority/P1")
        self.assertEqual(ev.title, "论文全文阅读器在长 PDF 上超时")
        self.assertTrue(ev.url.endswith("/issues/68"))
        self.assertEqual(normalized("github/issues_assigned").extra["assignee"], "bob")

    def test_comment_knows_its_target(self):
        ev = normalized("github/issue_comment_created")
        self.assertEqual(ev.extra["on"], "issue")
        self.assertEqual(ev.extra["comment_author"], "bob")

    def test_push_details(self):
        ev = normalized("github/push")
        self.assertEqual(ev.ref, "refs/heads/main")
        self.assertEqual(ev.extra["commits"], 1)

    def test_ping_and_installation(self):
        self.assertEqual(normalized("github/ping").extra["hook_type"], "App")
        self.assertEqual(normalized("github/installation_created").extra["repositories"], [GH])

    def test_unknown_event_route(self):
        self.assertEqual(normalized("github/unknown_star").route, "unknown.star")


class GitCodeDetailTests(unittest.TestCase):
    def test_merge_is_dedicated(self):
        ev = normalized("gitcode/merge_request_merge")
        self.assertEqual(ev.raw_action, "merge")
        self.assertEqual(ev.route, "pull_request.merged")
        self.assertEqual(ev.extra["state"], "merged")

    def test_update_with_oldrev_is_synchronize(self):
        ev = normalized("gitcode/merge_request_update")
        self.assertEqual(ev.extra["before"], "23adec6d9afeb011992b73d700c854ee9388205f")
        self.assertEqual(ev.extra["head_sha"], "34bedf7e0bfc122aa3c84e811d965ff0a4993161")

    def test_branches_and_labels(self):
        ev = normalized("gitcode/merge_request_open")
        self.assertEqual((ev.extra["head"], ev.extra["base"]), ("feat/board-priority", "main"))
        self.assertEqual(ev.extra["reviewers"], ["bob"])
        self.assertEqual(normalized("gitcode/issue_open").labels, ["kind/enhancement"])

    def test_note_targets(self):
        self.assertEqual(normalized("gitcode/note_issue").extra["on"], "issue")
        mr_note = normalized("gitcode/note_merge_request")
        self.assertEqual(mr_note.extra["on"], "pull_request")
        self.assertEqual(mr_note.number, 27)

    def test_falls_back_on_object_kind_without_event_header(self):
        payload = fixture("gitcode/issue_open")["payload"]
        ev = gitcode_adapter.normalize({}, payload)
        self.assertEqual((ev.kind, ev.action, ev.delivery_id), ("issue", "opened", payload["uuid"]))

    def test_provider_detection(self):
        self.assertEqual(detect_provider({"X-GitCode-Event": "Issue Hook"}), "gitcode")
        self.assertEqual(detect_provider({"X-GitHub-Event": "issues"}), "github")
        self.assertIsNone(detect_provider({"X-Gitlab-Event": "Issue Hook"}))


if __name__ == "__main__":
    unittest.main()
