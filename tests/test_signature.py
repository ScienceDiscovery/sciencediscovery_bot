import base64
import hashlib
import hmac
import unittest

from tests.helpers import SECRET
from sdbot.signature import sign, verify

BODY = b'{"action":"opened","number":1}'


class GitHubSignatureTests(unittest.TestCase):
    def test_valid_signature(self):
        result = verify("github", {"X-Hub-Signature-256": sign(BODY, SECRET)}, BODY, SECRET)
        self.assertTrue(result.ok)
        self.assertEqual(result.mode, "hmac-sha256")

    def test_header_lookup_is_case_insensitive(self):
        result = verify("github", {"x-hub-signature-256": sign(BODY, SECRET)}, BODY, SECRET)
        self.assertTrue(result.ok)

    def test_wrong_secret_is_rejected(self):
        result = verify("github", {"X-Hub-Signature-256": sign(BODY, "other")}, BODY, SECRET)
        self.assertFalse(result.ok)
        self.assertIn("mismatch", result.reason)

    def test_tampered_body_is_rejected(self):
        result = verify("github", {"X-Hub-Signature-256": sign(BODY, SECRET)}, BODY + b" ", SECRET)
        self.assertFalse(result.ok)

    def test_missing_signature_is_rejected_when_secret_set(self):
        result = verify("github", {}, BODY, SECRET)
        self.assertFalse(result.ok)
        self.assertIn("missing", result.reason)

    def test_malformed_signature_is_rejected(self):
        for value in ("sha1=abc", "abc", "sha256=", "sha256"):
            with self.subTest(value=value):
                self.assertFalse(verify("github", {"X-Hub-Signature-256": value}, BODY, SECRET).ok)

    def test_no_secret_means_unsigned_mode(self):
        result = verify("github", {}, BODY, None)
        self.assertTrue(result.ok)
        self.assertEqual(result.mode, "unsigned")


class GitCodeSignatureTests(unittest.TestCase):
    def test_hex_signature(self):
        result = verify("gitcode", {"X-GitCode-Signature-256": sign(BODY, SECRET)}, BODY, SECRET)
        self.assertTrue(result.ok)
        self.assertEqual(result.mode, "hmac-sha256")

    def test_base64_signature_also_accepted(self):
        digest = base64.b64encode(hmac.new(SECRET.encode(), BODY, hashlib.sha256).digest()).decode()
        result = verify("gitcode", {"X-GitCode-Signature-256": f"sha256={digest}"}, BODY, SECRET)
        self.assertTrue(result.ok)

    def test_wrong_signature_rejected(self):
        self.assertFalse(verify("gitcode", {"X-GitCode-Signature-256": sign(BODY, "nope")}, BODY, SECRET).ok)

    def test_token_mode(self):
        self.assertEqual(verify("gitcode", {"X-GitCode-Token": SECRET}, BODY, SECRET).mode, "token")
        self.assertFalse(verify("gitcode", {"X-GitCode-Token": "wrong"}, BODY, SECRET).ok)

    def test_signature_header_wins_over_token(self):
        headers = {"X-GitCode-Signature-256": sign(BODY, "nope"), "X-GitCode-Token": SECRET}
        self.assertFalse(verify("gitcode", headers, BODY, SECRET).ok)

    def test_missing_both_headers_rejected(self):
        result = verify("gitcode", {}, BODY, SECRET)
        self.assertFalse(result.ok)
        self.assertIn("missing", result.reason)


class UnknownProviderTests(unittest.TestCase):
    def test_unknown_provider_rejected(self):
        self.assertFalse(verify("bitbucket", {}, BODY, SECRET).ok)


if __name__ == "__main__":
    unittest.main()
