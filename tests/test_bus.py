import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from sdbot.bus import EventBus, Listener
from sdbot.events import Event
from sdbot.board import MultiBoardUpdater
from sdbot.config import Config
from sdbot.pipeline import Pipeline
from sdbot.router import Router
from sdbot.signature import sign
from sdbot.store import EventStore
from tests.helpers import SECRET, signed
from tests import test_server


class EventBusTests(unittest.TestCase):
    def listener(self, name='audit', handler=lambda event: None, **kw):
        return Listener(name, '审计', '记录业务事件', ('issue.*',), handler, **kw)

    def event(self, action='opened'):
        return Event('github', 'delivery', 'issue', action, repo='Example/Source')

    def test_independent_businesses_share_an_event_in_registration_order(self):
        bus, called = EventBus(), []
        for name in ('audit', 'notification'):
            bus.subscribe(self.listener(name, lambda event, name=name: called.append((name, event.repo))))
        outcome = bus.dispatch(self.event())
        self.assertEqual(called, [('audit', 'Example/Source'), ('notification', 'Example/Source')])
        self.assertEqual([r['id'] for r in outcome.listeners], ['audit', 'notification'])

    def test_disabled_excluded_and_other_scopes_do_not_run(self):
        bus, called = EventBus(), []
        base = self.listener(handler=lambda event: called.append(event.delivery_id),
                             providers=('github',), repositories=('example/source',), exclude=('issue.closed',))
        bus.subscribe(base)
        bus.subscribe(replace(base, id='disabled', enabled=False))
        for event in (self.event('closed'), replace(self.event(), provider='gitcode'), replace(self.event(), repo='other/repo')):
            self.assertFalse(bus.dispatch(event).handled)
        self.assertTrue(bus.dispatch(self.event()).handled)
        self.assertEqual(called, ['delivery'])
        self.assertEqual(bus.inventory()[1]['mode'], 'disabled')

    def test_exception_and_invalid_return_are_isolated_and_redacted(self):
        def fail(event):
            raise RuntimeError('private-business-secret')
        bus = EventBus()
        bus.subscribe(self.listener('fail', fail))
        bus.subscribe(self.listener('invalid', lambda event: 'not a dictionary'))
        bus.subscribe(self.listener('healthy'))
        outcome = bus.dispatch(self.event())
        self.assertEqual([r['status'] for r in outcome.listeners], ['error', 'error', 'ok'])
        self.assertEqual(len(outcome.errors), 2)
        self.assertNotIn('private-business-secret', str(outcome))

    def test_duplicate_id_and_invalid_selectors_refuse_registration(self):
        bus = EventBus(); listener = self.listener(); bus.subscribe(listener)
        for invalid in (listener, replace(listener, id=''), replace(listener, id='b', routes='issue.*'),
                        replace(listener, id='b', routes=()), replace(listener, id='b', mode='unknown')):
            with self.assertRaises(ValueError): bus.subscribe(invalid)
        self.assertEqual(len(bus.inventory()), 1)

    def test_registration_during_delivery_only_applies_to_next_delivery(self):
        bus, seen = EventBus(), []
        def register(event):
            if not seen:
                bus.subscribe(self.listener('next', lambda event: seen.append('next')))
            seen.append('first')
        bus.subscribe(self.listener('first', register))
        bus.dispatch(self.event()); self.assertEqual(seen, ['first'])
        bus.dispatch(self.event()); self.assertEqual(seen, ['first', 'first', 'next'])

    def test_real_board_inventory_contains_its_exact_source_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Config(data_dir=Path(tmp), board_targets={'Example/Source':'Example/Board'})
            entries = Router(board=MultiBoardUpdater(cfg)).bus.inventory()
        for entry in entries:
            if entry['business'] == '看板更新':
                self.assertEqual(entry['mode'], 'active')
                self.assertEqual(entry['providers'], ['github'])
                self.assertEqual(entry['repositories'], ['example/source'])
            else:
                self.assertEqual(entry['mode'], 'noop')

    def test_new_unknown_subscription_respects_pipeline_gates_and_is_archived(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg=Config(data_dir=Path(tmp), repos=('ScienceDiscovery/sciencediscovery',), secrets={'github':SECRET})
            router, seen = Router(), []
            router.bus.subscribe(Listener('audit.star', '审计', '星标事件', ('unknown.star',), lambda event: seen.append(event.delivery_id)))
            pipeline=Pipeline(cfg,EventStore(cfg.data_dir),router)
            body=json.dumps({'repository':{'full_name':'ScienceDiscovery/sciencediscovery'}}).encode()
            headers={'X-GitHub-Event':'star','X-GitHub-Delivery':'star-one','X-Hub-Signature-256':sign(body,SECRET)}
            first=pipeline.receive(headers,body)
            self.assertEqual(first.body, {'ok':True,'delivery_id':'star-one'})
            self.assertEqual(first.record['listeners'], [{'id':'audit.star','status':'ok'}])
            self.assertEqual(pipeline.store.detail(first.record['record_id'])['record']['listeners'], first.record['listeners'])
            self.assertTrue(pipeline.receive(headers,body).record['duplicate'])
            headers['X-Hub-Signature-256']='bad'; self.assertEqual(pipeline.receive(headers,body).status,401)
            body=b'{"repository":{"full_name":"Other/Source"}}';headers['X-Hub-Signature-256']=sign(body,SECRET)
            self.assertEqual(pipeline.receive(headers,body).record['status'],'ignored')
            self.assertEqual(seen,['star-one'])


class ListenerHTTPTests(unittest.TestCase):
    setUpClass = classmethod(test_server.ServerTests.setUpClass.__func__)
    tearDownClass = classmethod(test_server.ServerTests.tearDownClass.__func__)
    get = test_server.ServerTests.get
    post = test_server.ServerTests.post

    def test_inventory_is_the_actual_registry_and_only_available_on_admin(self):
        self.cfg.admin_token='listener-admin-test'
        auth={'Authorization':'Bearer '+self.cfg.admin_token}
        self.assertEqual(self.get(self.base+'/api/listeners')[0],404)
        self.assertEqual(self.get(self.admin_base+'/api/listeners')[0],401)
        self.assertEqual(self.get(self.admin_base+'/api/listeners', {**auth,'Cf-Ray':'test'})[0],403)
        seen=[]
        self.webhook.pipeline.router.bus.subscribe(Listener('custom.audit','自定义审计','接收 Issue',('issue.*',),lambda event:seen.append(event.delivery_id)))
        status, inventory = self.get(self.admin_base+'/api/listeners',auth)
        self.assertEqual(status,200)
        self.assertEqual(inventory['listeners'][-1]['id'],'custom.audit')
        self.assertNotIn('handler',inventory['listeners'][-1])
        headers,body=signed('github/issues_opened')
        status,response=self.post(self.base+'/webhook/github',body,headers)
        self.assertEqual(status,200); self.assertEqual(seen,[response['delivery_id']])
        status,events=self.get(self.admin_base+'/api/events?delivery_id='+response['delivery_id'],auth)
        self.assertIn({'id':'custom.audit','status':'ok'},events['events'][0]['listeners'])
