"""End-to-end over real HTTP: both listeners on ephemeral loopback ports, driven by scripts/replay.py."""

import io
import json
import os
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from tests.helpers import SECRET, fixture, fixture_path, replay
import server
from sdbot.config import Config
from sdbot.signature import sign

ADMIN_TOKEN = "admin-test-token"


class QuietWebhook(server.WebhookHandler):
    def log_message(self, *args):  # keep the access log out of the test output
        pass


class QuietAdmin(server.AdminHandler):
    def log_message(self, *args):
        pass


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.cfg = Config(data_dir=Path(cls._tmp.name), secrets={"github": SECRET, "gitcode": SECRET}, max_body_bytes=64 * 1024)
        pipeline = server.build(cls.cfg)
        cls.webhook = server.BotServer(("127.0.0.1", 0), QuietWebhook, pipeline, cls.cfg)
        cls.admin = server.BotServer(("127.0.0.1", 0), QuietAdmin, pipeline, cls.cfg)
        for srv in (cls.webhook, cls.admin):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.webhook.server_address[1]}"
        cls.admin_base = f"http://127.0.0.1:{cls.admin.server_address[1]}"
        cls._env = dict(os.environ)
        os.environ["SDBOT_WEBHOOK_SECRET"] = SECRET
        os.environ.pop("SDBOT_ADMIN_TOKEN", None)

    @classmethod
    def tearDownClass(cls):
        for srv in (cls.webhook, cls.admin):
            srv.shutdown()
            srv.server_close()
        os.environ.clear()
        os.environ.update(cls._env)
        cls._tmp.cleanup()

    def get(self, url, headers=None):
        try:
            with urlopen(Request(url, headers=headers or {}), timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode())
        except HTTPError as err:
            return err.code, json.loads(err.read().decode() or "{}")

    def post(self, url, data=b"{}", headers=None):
        try:
            with urlopen(Request(url, data=data, headers=headers or {}, method="POST"), timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode())
        except HTTPError as err:
            return err.code, json.loads(err.read().decode() or "{}")

    def replay(self, *args):
        out = io.StringIO()
        results = replay.run(["--url", self.base + "/webhook", "--admin-url", self.admin_base, *args], out=out)
        return results, out.getvalue()

    # ------------------------------------------------------------ webhook listener (public)
    def test_public_surface_is_minimal(self):
        self.assertEqual(self.get(self.base + "/healthz"), (200, {"ok": True}))
        for path in ("/", "/api/status", "/api/events", "/index.html", "/webhook", "/.env", "/.git/config", "/static/index.html"):
            status, doc = self.get(self.base + path)
            self.assertEqual(status, 404, path)
            self.assertEqual(doc, {"ok": False, "error": "not found"}, path)
        status, doc = self.post(self.base + "/api/replay/x", headers={"X-GitHub-Event": "ping"})
        self.assertEqual(status, 404)

    def test_public_reply_carries_no_internals(self):
        results, _ = self.replay(str(fixture_path("github/pull_request_closed_merged")))
        reply = results[0]["reply"]
        self.assertEqual(set(reply), {"ok", "delivery_id"})
        results, _ = self.replay(str(fixture_path("github/ping")))
        self.assertEqual(set(results[0]["reply"]), {"ok", "delivery_id", "pong"})
        results, _ = self.replay("--bad-signature", str(fixture_path("github/issues_opened")))
        self.assertEqual(results[0]["reply"], {"ok": False, "error": "signature verification failed"})

    def test_no_server_banner_on_public_listener(self):
        with urlopen(self.base + "/healthz", timeout=5) as resp:
            self.assertEqual(resp.headers.get("Server"), "sciencediscovery-bot")
        try:
            urlopen(Request(self.base + "/webhook", method="PUT", data=b"x"), timeout=5)
        except HTTPError as err:
            self.assertEqual(err.headers.get("Content-Type"), "application/json; charset=utf-8")
            self.assertNotIn("Python", err.headers.get("Server", ""))
            self.assertNotIn(b"<html", err.read().lower())
        else:
            self.fail("PUT should not be accepted")

    def test_replay_all_fixtures_signed(self):
        results, output = self.replay("--all")
        self.assertTrue(results)
        self.assertTrue(all(r["ok"] for r in results), output)
        routes = {Path(r["fixture"]).stem: r["record"]["route"] for r in results}
        self.assertEqual(routes["pull_request_closed_merged"], "pull_request.merged")
        self.assertEqual(routes["merge_request_merge"], "pull_request.merged")
        self.assertEqual(routes["ping"], "ping.ping")
        self.assertEqual(routes["unknown_star"], "unknown.star")
        self.assertIn("hooks=analyze.on_pull_request_merged,board.on_pull_request_merged", output)
        status, doc = self.get(self.admin_base + "/api/events?route=pull_request.merged&limit=10")
        self.assertEqual(status, 200)
        self.assertEqual({r["provider"] for r in doc["events"]}, {"gitcode", "github"})

    def test_bad_and_missing_signature_get_401(self):
        results, _ = self.replay("--bad-signature", str(fixture_path("github/issues_opened")))
        self.assertEqual(results[0]["status"], 401)
        self.assertEqual(results[0]["record"]["status"], "rejected")
        results, _ = self.replay("--no-signature", str(fixture_path("gitcode/issue_open")))
        self.assertEqual(results[0]["status"], 401)
        results, _ = self.replay("--token-mode", "--bad-signature", str(fixture_path("gitcode/issue_open")))
        self.assertEqual(results[0]["status"], 401)

    def test_forced_provider_route(self):
        results, _ = self.replay("--url", self.base + "/webhook/gitcode", str(fixture_path("gitcode/push")))
        self.assertEqual((results[0]["status"], results[0]["record"]["route"]), (200, "push.pushed"))

    def test_ordinary_webhooks_without_app_installation(self):
        cases = (
            ("ping", "ping.ping", []),
            ("issues_opened", "issue.opened", ["analyze.on_issue", "board.on_issue"]),
            ("pull_request_opened", "pull_request.opened", ["analyze.on_pull_request", "board.on_pull_request"]),
            ("pull_request_closed_merged", "pull_request.merged",
             ["analyze.on_pull_request_merged", "board.on_pull_request_merged"]),
            ("unknown_star", "unknown.star", []),
        )
        for target in ("organization", "repository", None):
            for content_type in ("application/json", "application/x-www-form-urlencoded"):
                for name, route, hooks in cases:
                    with self.subTest(target=target, content_type=content_type, event=name):
                        sample = fixture("github/" + name)
                        payload = sample["payload"]
                        payload.pop("installation", None)
                        if target == "organization":
                            payload["organization"] = {"login": "openJiuwen-ai", "id": 1001}
                        if name == "ping":
                            payload["hook"] = {"type": "Organization" if target == "organization" else "Repository",
                                               "id": 1234, "active": True, "events": ["issues", "pull_request"]}
                        text = json.dumps(payload, ensure_ascii=False)
                        body = (urlencode({"payload": text}) if content_type.endswith("urlencoded") else text).encode()
                        delivery = str(uuid.uuid4())
                        headers = {"Content-Type": content_type, "X-GitHub-Event": sample["event"],
                                   "X-GitHub-Delivery": delivery, "X-Hub-Signature-256": sign(body, SECRET)}
                        if target:
                            headers.update({"X-GitHub-Hook-Installation-Target-Type": target,
                                            "X-GitHub-Hook-Installation-Target-ID": "1001"})
                        path = "/webhook/github" if target else "/webhook"
                        status, reply = self.post(self.base + path, body, headers)
                        expected = {"ok": True, "delivery_id": delivery}
                        if name == "ping":
                            expected["pong"] = True
                        self.assertEqual((status, reply), (200, expected))
                        status, listing = self.get(self.admin_base + "/api/events?delivery_id=" + delivery)
                        self.assertEqual(status, 200)
                        record = listing["events"][0]
                        self.assertEqual((record["route"], record["hooks"]), (route, hooks))
                        self.assertEqual(record["verification"], "hmac-sha256")
                        self.assertNotIn("installation_id", record["extra"])
                        self.assertEqual(record["extra"].get("hook_target"), target + ":1001" if target else None)
                        status, detail = self.get(self.admin_base + "/api/events/" + record["record_id"])
                        self.assertEqual(status, 200)
                        self.assertEqual(detail["request"]["body"].encode(), body)
                        self.assertEqual(detail["response"]["status"], 200)
                        self.assertEqual(json.loads(detail["response"]["body"]), expected)
                        self.assertEqual(self.get(self.base + "/api/events/" + record["record_id"])[0], 404)

    def test_ordinary_form_webhook_requires_signature_over_raw_body(self):
        payload = fixture("github/issues_opened")["payload"]
        payload.pop("installation")
        decoded = json.dumps(payload, ensure_ascii=False).encode()
        body = urlencode({"payload": decoded.decode()}).encode()
        for signature in (None, sign(decoded, SECRET), sign(body + b"tampered", SECRET)):
            with self.subTest(signature_present=signature is not None):
                headers = {"Content-Type": "application/x-www-form-urlencoded", "X-GitHub-Event": "issues",
                           "X-GitHub-Delivery": str(uuid.uuid4())}
                if signature:
                    headers["X-Hub-Signature-256"] = signature
                self.assertEqual(self.post(self.base + "/webhook/github", body, headers),
                                 (401, {"ok": False, "error": "signature verification failed"}))
                # A rejected attempt must not prevent a corrected delivery from triggering hooks.
                headers["X-Hub-Signature-256"] = sign(body, SECRET)
                self.assertEqual(self.post(self.base + "/webhook/github", body, headers)[0], 200)
                self.assertEqual(self.post(self.base + "/webhook/github", body, headers)[0], 200)
                status, listing = self.get(self.admin_base + "/api/events?delivery_id=" + headers["X-GitHub-Delivery"])
                self.assertEqual(status, 200)
                duplicate, accepted, rejected = listing["events"]
                self.assertEqual(rejected["status"], "rejected")
                self.assertEqual(accepted["hooks"], ["analyze.on_issue", "board.on_issue"])
                self.assertFalse(accepted["duplicate"])
                self.assertTrue(duplicate["duplicate"])
                self.assertEqual(duplicate["hooks"], [])
                self.assertEqual(len({row["record_id"] for row in listing["events"]}), 3)

    def test_oversized_body_413(self):
        status, doc = self.post(self.base + "/webhook", b"x" * (64 * 1024 + 1), {"X-GitHub-Event": "push"})
        self.assertEqual((status, doc["error"]), (413, "payload too large"))

    def test_unknown_provider_path_404(self):
        for path in ("/webhook/bitbucket", "/webhook/github/", "/webhook/foo/bar", "/webhooks"):
            self.assertEqual(self.post(self.base + path)[0], 404, path)

    # ------------------------------------------------------------ admin listener
    def test_admin_status_and_panel(self):
        status, doc = self.get(self.admin_base + "/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(doc["config"]["providers"]["github"]["secret_configured"])
        self.assertNotIn(SECRET, json.dumps(doc))
        with urlopen(self.admin_base + "/", timeout=5) as resp:
            self.assertIn(b"<!doctype html>", resp.read().lower())
        self.assertEqual(self.get(self.admin_base + "/healthz")[0], 200)

    def test_admin_refuses_tunnelled_requests(self):
        for header in ("Cf-Connecting-Ip", "Cf-Ray", "CF-Worker", "cF-vIsItOr", "Cf-Access-Jwt-Assertion"):
            for value in ("203.0.113.9", ""):
                for path in ("/api/status", "/api/events", "/", "/healthz"):
                    self.assertEqual(self.get(self.admin_base + path, {header: value})[0], 403, (header, path))
                self.assertEqual(self.post(self.admin_base + "/api/replay/x", headers={header: value})[0], 403)
        # the webhook listener does not care about those headers
        with urlopen(Request(self.base + "/healthz", headers={"Cf-Ray": "abc"}), timeout=5) as resp:
            self.assertEqual(resp.status, 200)

    def test_admin_token(self):
        self.cfg.admin_token = ADMIN_TOKEN
        try:
            self.assertEqual(self.get(self.admin_base + "/api/status")[0], 401)
            self.assertEqual(self.get(self.admin_base + "/api/status", {"Authorization": "Bearer nope"})[0], 401)
            self.assertEqual(self.get(self.admin_base + "/api/status", {"Authorization": f"Bearer {ADMIN_TOKEN}"})[0], 200)
            self.assertEqual(self.get(self.admin_base + "/api/status", {"Authorization": f"Bearer {ADMIN_TOKEN}", "Cf-Ray": "abc"})[0], 403)
            self.assertEqual(self.get(self.admin_base + "/api/events")[0], 401)
            self.assertEqual(self.post(self.admin_base + "/api/replay/x")[0], 401)
            self.assertEqual(self.get(self.admin_base + "/api/status?token=" + ADMIN_TOKEN)[0], 401)
            self.assertEqual(self.get(self.base + "/healthz")[0], 200)   # public listener unaffected
        finally:
            self.cfg.admin_token = ""

    def test_panel_shell_loads_before_bearer_auth(self):
        self.cfg.admin_token = ADMIN_TOKEN
        try:
            with urlopen(self.admin_base + "/", timeout=5) as resp:
                html = resp.read().decode()
            self.assertIn("location.hash.slice(1)", html)
            self.assertNotIn(ADMIN_TOKEN, html)
            self.assertNotIn(str(self.cfg.data_dir), html)
            self.assertEqual(self.get(self.admin_base + "/api/status")[0], 401)
        finally:
            self.cfg.admin_token = ""

    def test_access_logs_do_not_include_credentials(self):
        output = io.StringIO()
        with patch.object(QuietAdmin, "log_message", server.JSONHandler.log_message), patch("sys.stderr", output):
            self.assertEqual(self.get(self.admin_base + "/api/status?token=" + ADMIN_TOKEN,
                                      {"User-Agent": SECRET, "Authorization": f"Bearer {ADMIN_TOKEN}"})[0], 200)
        self.assertIn("status=200", output.getvalue())
        self.assertNotIn(ADMIN_TOKEN, output.getvalue())
        self.assertNotIn(SECRET, output.getvalue())

    def test_admin_replay_action(self):
        results, _ = self.replay(str(fixture_path("gitcode/merge_request_merge")))
        delivery = results[0]["record"]["delivery_id"]
        status, doc = self.post(self.admin_base + f"/api/replay/{delivery}")
        self.assertEqual(status, 403)   # marker header required
        status, doc = self.post(self.admin_base + f"/api/replay/{delivery}", headers={"X-Requested-With": "sciencediscovery-bot"})
        self.assertEqual(status, 200)
        self.assertEqual(doc["record"]["route"], "pull_request.merged")
        self.assertNotEqual(doc["record"]["delivery_id"], delivery)
        self.assertEqual(doc["record"]["verification"], "hmac-sha256")
        self.assertEqual(doc["record"]["hooks"], ["analyze.on_pull_request_merged", "board.on_pull_request_merged"])
        status, _ = self.post(self.admin_base + "/api/replay/does-not-exist", headers={"X-Requested-With": "sciencediscovery-bot"})
        self.assertEqual(status, 404)

    def test_print_curl_is_self_contained(self):
        out = io.StringIO()
        replay.run(["--print-curl", str(fixture_path("github/ping"))], out=out)
        text = out.getvalue()
        self.assertIn("X-Hub-Signature-256: sha256=", text)
        self.assertIn("--data-binary @-", text)

    def test_print_curl_does_not_print_gitcode_password(self):
        out = io.StringIO()
        replay.run(["--print-curl", "--token-mode", str(fixture_path("gitcode/issue_open"))], out=out)
        self.assertNotIn(SECRET, out.getvalue())
        self.assertIn("${SDBOT_GITCODE_WEBHOOK_SECRET", out.getvalue())


class ConfigValidationTests(unittest.TestCase):
    def test_non_loopback_needs_explicit_flag(self):
        cfg = Config(webhook_host="0.0.0.0")
        self.assertTrue(any("loopback" in p for p in cfg.validate()))
        self.assertEqual(Config(webhook_host="0.0.0.0", admin_host="0.0.0.0", allow_non_loopback=True).validate(), [])

    def test_reserved_ports_and_port_clash(self):
        self.assertTrue(any("4310" in p for p in Config(webhook_port=4310).validate()))
        self.assertTrue(any("share" in p for p in Config(webhook_port=9000, admin_port=9000).validate()))


if __name__ == "__main__":
    unittest.main()
