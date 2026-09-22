import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from sdbot.board import MultiBoardUpdater
from sdbot.config import Config, DEFAULT_REPOS
from sdbot.pipeline import Pipeline
from sdbot.router import Router
from sdbot.signature import sign
from sdbot.store import EventStore


TARGETS = {"openJiuwen-ai/sciencediscovery": "ScienceDiscovery/github-status-board",
           "ScienceDiscovery/sciencediscovery": "ScienceDiscovery/github-status-board-test"}


class RepositoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cfg = Config(data_dir=Path(self.tmp.name), repos=DEFAULT_REPOS,
                          board_targets=TARGETS, board_token="test-token", secrets={"github": "test-secret"})
        self.board = MultiBoardUpdater(self.cfg)
        self.pipeline = Pipeline(self.cfg, EventStore(self.cfg.data_dir), Router(board=self.board))

    def deliver(self, repo, delivery="delivery", kind="issues", action="opened", signature=True):
        payload = {"action": action, "repository": {"full_name": repo}, "issue": {"number": 17}}
        body = json.dumps(payload).encode()
        headers = {"X-GitHub-Event": kind, "X-GitHub-Delivery": delivery,
                   "X-Hub-Signature-256": sign(body, "test-secret") if signature else "invalid"}
        reply = self.pipeline.receive(headers, body)
        detail = self.pipeline.store.detail(reply.record["record_id"])
        self.assertEqual(detail["request"]["body"].encode(), body)
        self.assertEqual(json.loads(detail["response"]["body"]), reply.body)
        return reply

    def test_both_sources_trigger_only_their_own_queue_and_survive_restart(self):
        for i, source in enumerate(TARGETS):
            reply = self.deliver(source.upper(), str(i))
            self.assertEqual(reply.record["hooks"], ["analyze.on_issue", "board.on_issue"])
            self.assertEqual(set(reply.body), {"ok", "delivery_id"})
            self.assertTrue(self.deliver(source, str(i)).record["duplicate"])
        recovered = MultiBoardUpdater(self.cfg)
        self.assertEqual(len({b.path for b in recovered.boards.values()}), 2)
        for board in recovered.boards.values():
            self.assertEqual(board.status()["requested"], 1)
        production, experiment = recovered.boards.values()
        production.runner = lambda: "a" * 40
        production.run_once()
        self.assertFalse(production.status()["pending"])
        self.assertTrue(experiment.status()["pending"])
        def fail():
            raise RuntimeError("test-token")
        experiment.runner = fail
        experiment.run_once()
        self.assertTrue(experiment.status()["pending"])
        self.assertNotIn("test-token", experiment.path.read_text())
        self.assertEqual(production.status()["commit"], "a" * 40)

    def test_other_repos_and_repositoryless_events_are_archived_without_hooks(self):
        for repo in ("other/sciencediscovery", "openJiuwen/sciencediscovery", "", "ScienceDiscovery/github-status-board"):
            reply = self.deliver(repo, repo or "missing")
            self.assertEqual((reply.status, reply.record["status"], reply.record["hooks"]), (200, "ignored", []))
        self.assertFalse(self.pipeline.router.analyze.calls)
        self.assertTrue(all(b.status()["requested"] == 0 for b in self.board.boards.values()))

    def test_signature_and_ping_protocol_are_preserved(self):
        self.assertEqual(self.deliver(next(iter(TARGETS)), signature=False).status, 401)
        self.assertTrue(self.deliver("", "ping", kind="ping").body["pong"])
        self.assertTrue(all(b.status()["requested"] == 0 for b in self.board.boards.values()))

    def test_gitcode_cannot_trigger_a_same_name_github_target(self):
        self.assertFalse(self.cfg.tracks("openJiuwen-ai/sciencediscovery", "gitcode"))

    def test_blank_environment_cannot_open_the_production_allowlist(self):
        for value in ("", "  ", " , , "):
            with patch.dict("os.environ", {"SDBOT_REPOS": value}, clear=True):
                cfg = Config.from_env()
            self.assertEqual(cfg.repos, DEFAULT_REPOS)
            self.assertFalse(cfg.tracks("another/repo"))

    def test_targets_validate_and_reject_collisions_or_untracked_sources(self):
        self.assertEqual(self.cfg.validate(), [])
        self.cfg.board_targets = dict.fromkeys(TARGETS, "ScienceDiscovery/shared-board")
        self.assertIn("board sources and destinations must each be unique", self.cfg.validate())
        self.cfg.board_targets = {"other/source": "example/board"}
        self.assertIn("board sources must be included in SDBOT_REPOS", self.cfg.validate())

    def test_changing_a_destination_does_not_reuse_old_success(self):
        source = next(iter(TARGETS))
        self.deliver(source)
        self.cfg.board_targets = {source: "ScienceDiscovery/new-board"}
        moved = MultiBoardUpdater(self.cfg).boards[source.lower()]
        self.assertFalse(moved.status()["pending"])
        self.assertNotEqual(moved.path, self.board.boards[source.lower()].path)


class RepositoryHTTPTests(unittest.TestCase):
    from tests.test_server import ServerTests
    setUpClass = classmethod(ServerTests.setUpClass.__func__)
    tearDownClass = classmethod(ServerTests.tearDownClass.__func__)
    get = ServerTests.get
    post = ServerTests.post

    def test_public_delivery_and_admin_archive_for_tracked_and_ignored_sources(self):
        from tests.helpers import SECRET
        self.cfg.repos = DEFAULT_REPOS
        for i, repo in enumerate([*TARGETS, 'untracked/source']):
            delivery = 'scope-http-' + str(i)
            body = json.dumps({'action': 'opened', 'repository': {'full_name': repo},
                               'issue': {'number': 1}}).encode()
            headers = {'X-GitHub-Event': 'issues', 'X-GitHub-Delivery': delivery,
                       'Content-Type': 'application/json',
                       'X-Hub-Signature-256': sign(body, SECRET)}
            status, response = self.post(self.base + '/webhook/github', body, headers)
            self.assertEqual((status, response), (200, {'ok': True, 'delivery_id': delivery}))
            status, listing = self.get(self.admin_base + '/api/events?delivery_id=' + delivery)
            record = listing['events'][0]
            self.assertEqual(record['status'], 'accepted' if i < 2 else 'ignored')
            self.assertEqual(record['hooks'], ['analyze.on_issue', 'board.on_issue'] if i < 2 else [])
            status, detail = self.get(self.admin_base + '/api/events/' + record['record_id'])
            self.assertEqual(detail['request']['body'].encode(), body)
            self.assertEqual(json.loads(detail['response']['body']), response)
