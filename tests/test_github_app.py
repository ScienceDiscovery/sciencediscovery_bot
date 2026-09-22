import base64
from datetime import datetime, timezone
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from sdbot.board import StaticBoardUpdater
from sdbot.config import Config
from sdbot.github_app import GitHubApp, GitHubAppAuthError, load_private_key


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.pem = cls.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                        serialization.NoEncryption()).decode()

    def test_jwt_rsa_signature_and_clock_skew(self):
        app = GitHubApp('123', self.pem.replace('\n', '\\n'))
        with patch('sdbot.github_app.time.time', return_value=1800000000):
            jwt = app._jwt()
        header, body, signature = jwt.split('.')
        decode = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
        self.assertEqual(json.loads(decode(header)), {'alg':'RS256','typ':'JWT'})
        self.assertEqual(json.loads(decode(body)), {'iat':1799999940,'exp':1800000540,'iss':'123'})
        self.key.public_key().verify(decode(signature), (header+'.'+body).encode(), padding.PKCS1v15(), hashes.SHA256())

    def test_separate_installations_and_repository_scoped_permissions(self):
        app = GitHubApp('123', self.pem)
        calls=[]
        def request(method, path, body=None):
            calls.append((method,path,body))
            if method=='GET':
                return {'id': 11 if 'source-org/' in path else 22}
            return {'token': 'read-only-token' if '/11/' in path else 'write-token',
                    'expires_at':datetime.fromtimestamp(1800003600,timezone.utc).isoformat()}
        with patch.object(app,'_request',side_effect=request), patch('sdbot.github_app.time.time',return_value=1800000000):
            self.assertEqual(app.token_for('source-org/project'),'read-only-token')
            self.assertEqual(app.token_for('board-org/dashboard',write=True),'write-token')
            app.token_for('source-org/project')
        self.assertEqual(len(calls),6)  # Fresh credentials on each publication/retry.
        self.assertEqual(calls[1][2]['repositories'],['project'])
        self.assertTrue(all(v=='read' for v in calls[1][2]['permissions'].values()))
        self.assertEqual(calls[3][2],{'repositories':['dashboard'],'permissions':{'metadata':'read','contents':'write'}})

    def test_expired_malformed_and_suspended_credentials_are_rejected(self):
        app=GitHubApp('123',self.pem)
        for result in ({}, {'token':'secret','expires_at':'bad'}, {'token':'secret','expires_at':'2000-01-01T00:00:00Z'}):
            with patch.object(app,'_request',side_effect=[{'id':11},result]):
                with self.assertRaises(GitHubAppAuthError) as error: app.token_for('org/repo')
                self.assertNotIn('secret',str(error.exception))
        for installation in ({'id':None},{'id':11,'suspended_at':'today'}):
            with patch.object(app,'_request',return_value=installation) as request:
                with self.assertRaises(GitHubAppAuthError): app.token_for('org/repo')
                self.assertEqual(request.call_count,1)

    def test_http_failure_and_redirect_do_not_expose_or_forward_credentials(self):
        app=GitHubApp('123',self.pem)
        error=HTTPError('https://api.github.com/test',403,'secret-body',{},io.BytesIO(b'private-secret'))
        with patch.object(app._opener,'open',side_effect=error):
            with self.assertRaises(GitHubAppAuthError) as raised: app._request('GET','/app')
        self.assertNotIn('secret',str(raised.exception))
        from sdbot.github_app import _NoRedirect
        self.assertIsNone(_NoRedirect().redirect_request(None,None,302,'',{},'https://other.invalid'))

    def test_config_requires_complete_unambiguous_credentials_and_rsa(self):
        root=Path(__file__).resolve().parents[1]
        cfg=Config(board_repo='org/board',board_track_repo='org/source',board_source_dir=root.parent/'github_status_board',
                   github_app_id='123',github_app_private_key=self.pem,secrets={'github':'secret'})
        self.assertEqual(cfg.validate(),[])
        self.assertNotIn(self.pem,repr(cfg))
        self.assertNotIn('PRIVATE KEY',json.dumps(cfg.public()))
        cfg.board_token='token'
        self.assertIn('choose GitHub App credentials or board token, not both',cfg.validate())
        cfg.board_token=''
        cfg.github_app_private_key=''
        self.assertIn('GitHub App ID and private key must both be configured',cfg.validate())
        ec_pem=ec.generate_private_key(ec.SECP256R1()).private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
        with self.assertRaises(ValueError): load_private_key(ec_pem)
        cfg.github_app_private_key='invalid-sensitive-key'
        self.assertNotIn('invalid-sensitive-key',str(cfg.validate()))

    def test_publisher_gets_two_tokens_but_no_app_private_key(self):
        cfg=Config(board_repo='board-org/board',board_track_repo='source-org/source',
                   github_app_id='123',github_app_private_key=self.pem)
        hook=StaticBoardUpdater(cfg)
        with patch('sdbot.github_app.GitHubApp.token_for',side_effect=['source-token','destination-token']) as tokens, \
             patch('sdbot.board.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'commit':'a'*40}))) as run:
            self.assertEqual(hook._publish(),'a'*40)
        self.assertEqual(tokens.call_args_list[0].args,('source-org/source',))
        self.assertEqual(tokens.call_args_list[1].kwargs,{'write':True})
        env=run.call_args.kwargs['env']
        self.assertEqual(env['GITHUB_TOKEN'],'source-token')
        self.assertEqual(env['GSB_PUBLISH_TOKEN'],'destination-token')
        self.assertNotIn(self.pem,repr(run.call_args))
        self.assertNotIn('SDBOT_GITHUB_APP_PRIVATE_KEY',env)

