import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from sdbot.board import StaticBoardUpdater
from sdbot.config import Config
from sdbot.events import Event
from sdbot.router import Router
from sdbot.pipeline import Pipeline
from sdbot.store import EventStore
from sdbot.signature import sign

ROOT = Path(__file__).resolve().parent.parent

class BoardTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.addCleanup(self.temp.cleanup)
        self.cfg = Config(data_dir=Path(self.temp.name), board_repo='example/board', board_track_repo='example/source', board_token='unit-token', secrets={'github':'unit-secret'})

    def event(self, repo='example/source'):
        return Event('github','delivery','issue','opened',repo=repo)

    def test_coalescing_and_recovery(self):
        calls=[]
        hook=StaticBoardUpdater(self.cfg, lambda: calls.append(1) or 'a'*40)
        for _ in range(10): hook.on_issue(self.event())
        recovered=StaticBoardUpdater(self.cfg, hook.runner)
        self.assertTrue(recovered.status()['pending'])
        recovered.run_once()
        self.assertEqual(calls,[1])
        self.assertFalse(recovered.status()['pending'])
        self.assertEqual(recovered.status()['completed'],10)

    def test_new_event_during_publication_is_not_lost(self):
        hook=StaticBoardUpdater(self.cfg)
        hook.runner=lambda: hook.on_issue(self.event()) or 'a'*40
        hook.request_refresh()
        hook.run_once()
        self.assertTrue(hook.status()['pending'])
        self.assertEqual(hook.status()['completed'],1)

    def test_failure_is_durable_and_redacted(self):
        def fail(): raise RuntimeError(self.cfg.board_token)
        hook=StaticBoardUpdater(self.cfg,fail)
        hook.request_refresh()
        hook.run_once()
        self.assertTrue(hook.status()['pending'])
        self.assertEqual(hook.status()['error'],'RuntimeError')
        self.assertNotIn(self.cfg.board_token,hook.path.read_text())
        hook.runner=lambda:'a'*40
        hook.run_once()
        self.assertFalse(hook.status()['pending'])

    def test_other_repository_is_not_a_trigger(self):
        hook=StaticBoardUpdater(self.cfg)
        self.assertEqual(hook.on_issue(self.event('example/other'))['status'],'ignored')
        self.assertFalse(hook.status()['pending'])

    def test_signed_quality_events_and_duplicates(self):
        hook=StaticBoardUpdater(self.cfg)
        pipeline=Pipeline(self.cfg,EventStore(self.cfg.data_dir),Router(board=hook))
        body=json.dumps({'action':'completed','repository':{'full_name':'example/source'}}).encode()
        for name in ('workflow_run','workflow_job','check_run','check_suite','status','release'):
            headers={'X-GitHub-Event':name,'X-GitHub-Delivery':name,'X-Hub-Signature-256':sign(body,'unit-secret')}
            self.assertEqual(pipeline.receive(headers,body).record['hooks'],['board.on_quality'])
            self.assertEqual(pipeline.receive(headers,body).record['hooks'],[])
        self.assertEqual(hook.status()['requested'],6)
        headers['X-Hub-Signature-256']='sha256=bad'
        self.assertEqual(pipeline.receive(headers,body).status,401)
        self.assertEqual(hook.status()['requested'],6)

    def test_publisher_receives_only_its_credential(self):
        from types import SimpleNamespace
        hook=StaticBoardUpdater(self.cfg)
        with patch.dict('os.environ',{'CLOUDFLARE_TUNNEL_TOKEN':'do-not-copy','SDBOT_ADMIN_TOKEN':'private'}), patch('sdbot.board.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'commit':'a'*40}))) as run:
            self.assertEqual(hook._publish(),'a'*40)
        env=run.call_args.kwargs['env']
        self.assertEqual(env['GITHUB_TOKEN'],'unit-token')
        self.assertNotIn('CLOUDFLARE_TUNNEL_TOKEN',env)
        self.assertNotIn('SDBOT_ADMIN_TOKEN',env)
        self.assertNotIn('unit-token',' '.join(run.call_args.args[0]))
