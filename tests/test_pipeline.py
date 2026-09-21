import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from tests.helpers import SECRET, fixture, signed
from sdbot.config import Config
from sdbot.pipeline import Pipeline
from sdbot.router import Router
from sdbot.store import EventStore


def make_pipeline(tmp: str, secrets=None, **cfg_overrides) -> Pipeline:
    cfg = Config(data_dir=Path(tmp), secrets=secrets if secrets is not None else {"github": SECRET, "gitcode": SECRET}, **cfg_overrides)
    store = EventStore(cfg.data_dir)
    return Pipeline(cfg, store, Router())


def log_lines(tmp: str) -> list[dict]:
    path = Path(tmp) / "events.jsonl"
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name
        self.pipeline = make_pipeline(self.tmp)

    def tearDown(self):
        self._tmp.cleanup()

    def test_signed_delivery_is_routed_and_logged(self):
        headers, body = signed("github/pull_request_closed_merged")
        reply = self.pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(set(reply.body), {"ok", "delivery_id"})   # public answer carries nothing else
        self.assertEqual(reply.record["route"], "pull_request.merged")
        self.assertEqual(reply.record["hooks"], ["analyze.on_pull_request_merged", "board.on_pull_request_merged"])
        record = log_lines(self.tmp)[-1]
        self.assertEqual(record, reply.record)
        self.assertEqual(record["status"], "accepted")
        self.assertEqual(record["verification"], "hmac-sha256")
        for key in ("delivery_id", "kind", "action", "repo", "number", "received_at", "raw_event"):
            self.assertIn(key, record)
        self.assertEqual((record["repo"], record["number"], record["merged"]), ("openJiuwen-ai/sciencediscovery", 51, True))
        payload_file = Path(self.tmp) / record["payload_file"]
        self.assertEqual(payload_file.read_bytes(), body)

    def test_ping_answers_pong(self):
        headers, body = signed("github/ping")
        reply = self.pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        self.assertTrue(reply.body["pong"])
        self.assertEqual(reply.record["route"], "ping.ping")

    def test_bad_signature_is_rejected_and_logged(self):
        headers, body = signed("github/issues_opened", bad_signature=True)
        reply = self.pipeline.receive(headers, body)
        self.assertEqual(reply.status, 401)
        record = log_lines(self.tmp)[-1]
        self.assertEqual(record["status"], "rejected")
        self.assertIsNotNone(record["payload_file"])
        self.assertNotIn(SECRET, json.dumps(record))

    def test_missing_signature_is_rejected(self):
        headers, body = signed("gitcode/issue_open", no_signature=True)
        self.assertEqual(self.pipeline.receive(headers, body).status, 401)

    def test_gitcode_token_mode_accepted(self):
        headers, body = signed("gitcode/merge_request_merge", token_mode=True)
        reply = self.pipeline.receive(headers, body)
        self.assertEqual((reply.status, reply.record["route"]), (200, "pull_request.merged"))
        self.assertEqual(log_lines(self.tmp)[-1]["verification"], "token")

    def test_unsigned_mode_when_no_secret(self):
        pipeline = make_pipeline(self.tmp, secrets={})
        headers, body = signed("github/issues_opened", secret=None)
        reply = pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(log_lines(self.tmp)[-1]["verification"], "unsigned")

    def test_unknown_provider_headers_400(self):
        reply = self.pipeline.receive({"Content-Type": "application/json"}, b"{}")
        self.assertEqual(reply.status, 400)

    def test_invalid_json_400(self):
        headers, _ = signed("github/issues_opened")
        from sdbot.signature import sign
        body = b"not json"
        headers["X-Hub-Signature-256"] = sign(body, SECRET)
        self.assertEqual(self.pipeline.receive(headers, body).status, 400)

    def test_unknown_event_is_recorded_with_2xx(self):
        headers, body = signed("github/unknown_star")
        reply = self.pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body, {"ok": True, "delivery_id": reply.record["delivery_id"]})
        self.assertFalse(reply.record["handled"])
        self.assertEqual(reply.record["hooks"], [])
        record = log_lines(self.tmp)[-1]
        self.assertEqual((record["status"], record["kind"], record["route"]), ("accepted", "unknown", "unknown.star"))

    def test_redelivery_is_flagged_and_skips_hooks(self):
        headers, body = signed("github/issues_opened", fresh_delivery=False)
        first = self.pipeline.receive(headers, body)
        second = self.pipeline.receive(headers, body)
        self.assertFalse(first.record["duplicate"])
        self.assertTrue(second.record["duplicate"])
        self.assertEqual(second.record["hooks"], [])
        self.assertEqual(second.body, first.body)   # the sender cannot tell a redelivery apart
        self.assertEqual(len(self.pipeline.router.analyze.calls), 1)

    def test_dedupe_survives_restart(self):
        headers, body = signed("github/issues_opened", fresh_delivery=False)
        self.pipeline.receive(headers, body)
        again = make_pipeline(self.tmp)   # new store instance reads the tail of the existing log
        self.assertTrue(again.receive(headers, body).record["duplicate"])

    def test_repo_allowlist(self):
        pipeline = make_pipeline(self.tmp, repos=("openjiuwen/sciencediscovery",))
        headers, body = signed("github/issues_opened")
        reply = pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        self.assertEqual(set(reply.body), {"ok", "delivery_id"})   # the allowlist is not revealed to the sender
        self.assertEqual(reply.record["status"], "ignored")
        self.assertEqual(log_lines(self.tmp)[-1]["status"], "ignored")
        headers, body = signed("gitcode/issue_open")
        self.assertEqual(pipeline.receive(headers, body).record["route"], "issue.opened")
        headers, body = signed("github/ping")   # no repo: always accepted
        self.assertTrue(pipeline.receive(headers, body).body["pong"])

    def test_form_encoded_github_delivery(self):
        from sdbot.signature import sign
        payload = fixture("github/issues_opened")["payload"]
        body = urlencode({"payload": json.dumps(payload)}).encode()
        headers = {"Content-Type": "application/x-www-form-urlencoded", "X-GitHub-Event": "issues",
                   "X-GitHub-Delivery": "form-1", "X-Hub-Signature-256": sign(body, SECRET)}
        reply = self.pipeline.receive(headers, body)
        self.assertEqual((reply.status, reply.record["route"]), (200, "issue.opened"))

    def test_large_payload_is_saved_in_full(self):
        pipeline = make_pipeline(self.tmp)
        headers, body = signed("github/push")
        from sdbot.signature import sign
        doc = json.loads(body)
        doc["large_field"] = "x" * (600 * 1024)
        body = json.dumps(doc).encode()
        headers["X-Hub-Signature-256"] = sign(body, SECRET)
        reply = pipeline.receive(headers, body)
        self.assertEqual(reply.status, 200)
        record = log_lines(self.tmp)[-1]
        self.assertIsNotNone(record["payload_file"])
        self.assertEqual(record["payload_bytes"], len(body))
        self.assertEqual(pipeline.store.payload_bytes(record), body)

    def test_recent_and_status(self):
        for name in ("github/issues_opened", "github/pull_request_opened", "gitcode/merge_request_merge"):
            headers, body = signed(name)
            self.pipeline.receive(headers, body)
        recent = self.pipeline.store.recent(10)
        self.assertEqual([r["route"] for r in recent], ["pull_request.merged", "pull_request.opened", "issue.opened"])
        self.assertEqual(len(self.pipeline.store.recent(10, kind="pull_request")), 2)
        self.assertEqual(len(self.pipeline.store.recent(10, number=27)), 1)
        status = self.pipeline.store.status()
        self.assertEqual(status["counts"]["accepted"], 3)
        self.assertEqual(status["counts"]["by_route"]["pull_request.merged"], 1)


if __name__ == "__main__":
    unittest.main()
