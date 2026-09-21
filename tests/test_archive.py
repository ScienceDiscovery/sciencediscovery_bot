import base64
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlencode

from sdbot.signature import sign
from sdbot.store import EventStore
from tests.helpers import SECRET, signed
from tests.test_pipeline import make_pipeline
from tests import test_server

ADMIN_TOKEN = test_server.ADMIN_TOKEN


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pipeline = make_pipeline(self.tmp.name)

    def test_each_attempt_keeps_request_and_response(self):
        headers, body = signed('github/issues_opened', fresh_delivery=False)
        first = self.pipeline.receive(headers, body)
        second = self.pipeline.receive(headers, body)
        headers['X-Hub-Signature-256'] = 'invalid'
        rejected = self.pipeline.receive(headers, body)
        self.assertEqual(len({r.record['record_id'] for r in (first, second, rejected)}), 3)
        self.assertTrue(second.record['duplicate'])
        for reply in (first, second, rejected):
            detail = self.pipeline.store.detail(reply.record['record_id'])
            self.assertEqual(detail['request']['body'].encode(), body)
            self.assertEqual(detail['response']['status'], reply.status)
            self.assertEqual(json.loads(detail['response']['body']), reply.body)
            self.assertEqual(detail['request']['headers']['X-Hub-Signature-256'], '[REDACTED]')

    def test_ignored_and_binary_rejected_payloads_are_retained(self):
        ignored = make_pipeline(self.tmp.name, repos=('not/tracked',))
        headers, body = signed('github/issues_opened')
        reply = ignored.receive(headers, body)
        self.assertEqual(reply.record['status'], 'ignored')
        self.assertEqual(ignored.store.detail(reply.record['record_id'])['request']['body'].encode(), body)
        body = b'\xff\x00bad json'
        headers['X-Hub-Signature-256'] = sign(body, SECRET)
        reply = self.pipeline.receive(headers, body)
        detail = self.pipeline.store.detail(reply.record['record_id'])
        self.assertEqual(reply.status, 400)
        self.assertEqual(detail['request']['body_encoding'], 'base64')
        self.assertEqual(base64.b64decode(detail['request']['body']), body)

    def test_credentials_are_redacted_before_writing(self):
        headers, body = signed('gitcode/issue_open', token_mode=True)
        headers.update({'Authorization': 'Bearer archive-test-credential-value', 'Cookie': 'session=archive-test-credential-value', 'X-Api-Key': 'archive-test-credential-value'})
        reply = self.pipeline.receive(headers, body, request={'path': '/webhook/gitcode?token=archive-test-credential-value'})
        all_files = b''.join(p.read_bytes() for p in Path(self.tmp.name).rglob('*') if p.is_file())
        self.assertNotIn(SECRET.encode(), all_files)
        self.assertNotIn(b'archive-test-credential-value', all_files)
        self.assertNotIn('archive-test-credential-value', json.dumps(reply.record))

    def test_restart_preserves_counters_and_details(self):
        headers, body = signed('github/ping', fresh_delivery=False)
        first = self.pipeline.receive(headers, body)
        self.pipeline.receive(headers, body)
        before = self.pipeline.store.status()['counts']
        restarted = make_pipeline(self.tmp.name)
        self.assertEqual(restarted.store.status()['counts'], before)
        self.assertEqual(restarted.store.detail(first.record['record_id'])['request']['body'].encode(), body)
        self.assertTrue(restarted.receive(headers, body).record['duplicate'])

    def test_history_queries_are_not_limited_to_recent_tail(self):
        # More than the old 4 MB / 200-row search window, without loading it all in a query.
        path = Path(self.tmp.name) / 'events.jsonl'
        with path.open('w') as stream:
            for i in range(300):
                stream.write(json.dumps({'delivery_id': f'old-{i}', 'status': 'accepted', 'route': 'ping.ping',
                                         'note': 'x' * 16384, 'number': i}) + '\n')
        store = EventStore(Path(self.tmp.name))
        self.assertEqual(store.recent(1, delivery_id='old-0')[0]['number'], 0)
        self.assertEqual([r['number'] for r in store.recent(2, offset=298)], [1, 0])
        self.assertEqual(store.status()['counts']['accepted'], 300)
        self.assertIsNotNone(store.detail(store.find('old-0')['record_id']))

    def test_legacy_missing_response_is_not_invented(self):
        root = Path(self.tmp.name)
        (root / 'old.json').write_text('{"old": true}')
        (root / 'events.jsonl').write_text(json.dumps({'delivery_id': 'legacy', 'status': 'accepted',
                                                      'payload_file': 'old.json'}) + '\n')
        store = EventStore(root)
        detail = store.detail(store.find('legacy')['record_id'])
        self.assertTrue(detail['legacy'])
        self.assertIsNone(detail['response'])
        self.assertEqual(detail['request']['body'], '{"old": true}')
        self.assertNotIn('headers', detail['request'])

    def test_exact_record_id_wins_over_platform_delivery_id(self):
        headers, body = signed('github/ping')
        first = self.pipeline.receive(headers, body)
        headers['X-GitHub-Delivery'] = first.record['record_id']
        second = self.pipeline.receive(headers, body)
        self.assertNotEqual(first.record['record_id'], second.record['record_id'])
        self.assertEqual(self.pipeline.store.find(first.record['record_id']), first.record)


# Reuse the HTTP fixture without inheriting and rerunning the original test methods.
class ArchiveHTTPTests(unittest.TestCase):
    setUpClass = classmethod(test_server.ServerTests.setUpClass.__func__)
    tearDownClass = classmethod(test_server.ServerTests.tearDownClass.__func__)
    get = test_server.ServerTests.get
    post = test_server.ServerTests.post
    replay = test_server.ServerTests.replay

    def details_for(self, delivery):
        status, listing = self.get(self.admin_base + '/api/events?delivery_id=' + delivery)
        self.assertEqual(status, 200)
        record = listing['events'][0]
        status, detail = self.get(self.admin_base + '/api/events/' + record['record_id'])
        self.assertEqual(status, 200)
        return detail

    def test_wrong_path_request_and_actual_response_are_saved(self):
        headers, body = signed('github/ping')
        status, reply = self.post(self.base + '/?token=hidden-query', body, headers)
        self.assertEqual(status, 404)
        detail = self.details_for(headers['X-GitHub-Delivery'])
        self.assertEqual(detail['request']['body'].encode(), body)
        self.assertTrue(detail['request']['body_complete'])
        self.assertEqual(detail['response']['status'], 404)
        self.assertEqual(json.loads(detail['response']['body']), reply)
        self.assertEqual(int(detail['response']['headers']['Content-Length']), len(detail['response']['body'].encode()))
        self.assertIn('Date', detail['response']['headers'])
        self.assertNotIn('hidden-query', json.dumps(detail))

    def test_oversized_prefix_is_saved_and_replay_refused(self):
        headers, body = signed('github/ping')
        body = b'x' * (self.cfg.max_body_bytes + 1)
        self.assertEqual(self.post(self.base + '/webhook', body, headers)[0], 413)
        detail = self.details_for(headers['X-GitHub-Delivery'])
        self.assertFalse(detail['request']['body_complete'])
        self.assertEqual(len(detail['request']['body']), self.cfg.max_body_bytes)
        self.assertEqual(detail['response']['status'], 413)
        self.assertEqual(self.post(self.admin_base + '/api/replay/' + detail['record']['record_id'],
                                  headers={'X-Requested-With': 'sciencediscovery-bot'})[0], 409)

    def test_archive_failure_is_not_acknowledged_as_success(self):
        headers, body = signed('github/ping')
        with patch.object(self.webhook.pipeline.store, 'save', side_effect=OSError('disk unavailable')):
            status, reply = self.post(self.base + '/webhook', body, headers)
        self.assertEqual((status, reply), (503, {'ok': False, 'error': 'storage unavailable'}))

    def test_interrupted_body_and_bad_length_are_recorded(self):
        for delivery, length, body in [('incomplete-archive', '9', b'abc'), ('bad-length-archive', 'oops', b'')]:
            with socket.create_connection(self.webhook.server_address, timeout=5) as conn:
                conn.sendall((f'POST /webhook HTTP/1.0\r\nContent-Length: {length}\r\n'
                              f'X-GitHub-Event: ping\r\nX-GitHub-Delivery: {delivery}\r\n\r\n').encode() + body)
                conn.shutdown(socket.SHUT_WR)
                response = b''
                while chunk := conn.recv(4096):
                    response += chunk
            self.assertIn(b' 400 ', response.split(b'\r\n')[0])
            detail = self.details_for(delivery)
            self.assertFalse(detail['request']['body_complete'])
            self.assertEqual(detail['request']['body'].encode(), body)
            self.assertEqual(detail['response']['status'], 400)

    def test_unhandled_pipeline_error_is_archived_as_500(self):
        headers, body = signed('github/ping')
        with patch.object(self.webhook.pipeline, 'receive', side_effect=ValueError('invalid event shape')):
            status, reply = self.post(self.base + '/webhook', body, headers)
        self.assertEqual((status, reply), (500, {'ok': False, 'error': 'internal error'}))
        detail = self.details_for(headers['X-GitHub-Delivery'])
        self.assertEqual(detail['request']['body'].encode(), body)
        self.assertEqual(detail['response']['status'], 500)

    def test_replay_preserves_form_content_type(self):
        headers, body = signed('github/ping')
        body = urlencode({'payload': body.decode()}).encode()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers['X-Hub-Signature-256'] = sign(body, SECRET)
        self.assertEqual(self.post(self.base + '/webhook', body, headers)[0], 200)
        first = self.details_for(headers['X-GitHub-Delivery'])
        status, result = self.post(self.admin_base + '/api/replay/' + first['record']['record_id'],
                                   headers={'X-Requested-With': 'sciencediscovery-bot'})
        self.assertEqual(status, 200)
        self.assertEqual(result['record']['route'], 'ping.ping')
        detail = self.get(self.admin_base + '/api/events/' + result['record']['record_id'])[1]
        self.assertEqual(detail['request']['body'].encode(), body)
        self.assertEqual(detail['request']['headers']['Content-Type'], 'application/x-www-form-urlencoded')

    def test_detail_api_is_admin_only_and_protected(self):
        headers, body = signed('github/ping')
        self.post(self.base + '/webhook', body, headers)
        detail = self.details_for(headers['X-GitHub-Delivery'])
        path = '/api/events/' + detail['record']['record_id']
        self.assertEqual(self.get(self.base + path)[0], 404)
        self.assertEqual(self.get(self.admin_base + path, {'Cf-Ray': 'abc'})[0], 403)
        self.cfg.admin_token = ADMIN_TOKEN
        try:
            self.assertEqual(self.get(self.admin_base + path)[0], 401)
            self.assertEqual(self.get(self.admin_base + path, {'Authorization': 'Bearer ' + ADMIN_TOKEN})[0], 200)
        finally:
            self.cfg.admin_token = ''

    def test_pagination_and_replay_use_exact_attempt(self):
        headers, body = signed('github/ping')
        self.post(self.base + '/webhook', body, headers)
        first = self.details_for(headers['X-GitHub-Delivery'])
        self.post(self.base + '/webhook', body, headers)
        second = self.details_for(headers['X-GitHub-Delivery'])
        self.assertNotEqual(first['record']['record_id'], second['record']['record_id'])
        self.assertEqual(self.get(self.admin_base + '/api/events?limit=1')[1]['has_more'], True)
        self.assertEqual(self.get(self.admin_base + '/api/events?limit=1&offset=1')[1]['events'][0]['record_id'], first['record']['record_id'])
        status, reply = self.post(self.admin_base + '/api/replay/' + first['record']['record_id'],
                                 headers={'X-Requested-With': 'sciencediscovery-bot'})
        self.assertEqual(status, 200)
        stored = self.get(self.admin_base + '/api/events/' + reply['record']['record_id'])[1]
        self.assertEqual(stored['record']['extra']['replayed_from'], first['record']['record_id'])
        self.assertEqual(stored['request']['source'], 'replay')
