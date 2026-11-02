import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('wake',Path(__file__).with_name('wake.py'))
assert spec and spec.loader
wake=importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)


def snapshot(draft='',notices=(),title='test-chat'):
    return {'version':'2.5','ok':True,'data':{'app':'ChatGPT','window':{'id':'w-1','title':title},'complete':True,'tree':{'role':'window','children':[
      {'role':'webarea','name':title,'children':[
       {'role':'text','name':'HANDOFF-CE-CHATGPT-WAKE-01'},
       *[{'role':'text','name':n}for n in notices],
       {'role':'textfield','name':'询问 ChatGPT','value':draft,'ref_id':'@new:e1'},
       {'role':'button','name':'发送','ref_id':'@new:e2','states':[] if draft else ['disabled']}]}]}}}


class Desktop:
    def __init__(self):self.draft='';self.notice=None;self.sends=0;self.unknown=False
    def snapshot(self):return snapshot(self.draft,[self.notice]if self.notice else [])
    def fill(self,ref,text):self.draft=text
    def submit(self,ref):
        self.sends+=1;self.notice=self.draft;self.draft=''
        if self.unknown:raise TimeoutError()


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.config={'windowId':'w-1','windowTitle':'test-chat','conversationMarker':'HANDOFF-CE-CHATGPT-WAKE-01','stateDir':self.tmp.name,'maxWaitSeconds':1,'pollSeconds':.001}
        self.record={'testId':'CE-WAKE-TEST-01-1','messageId':'msg_01M6D7BPKRDG38PE854761T7MN','to':'chatgpt/main','replyTo':'pi/wake-test','disposition':'CREATED'}
    def test_created_required_before_any_desktop(self):
        self.record['disposition']='UNKNOWN'
        with self.assertRaises(ValueError):wake.run(self.record,self.config,None)
    def test_notice_has_only_identifiers_not_payload(self):
        text=wake.notice(self.record)
        self.assertIn(self.record['messageId'],text);self.assertIn('ce_read_payload',text)
        with self.assertRaises(ValueError):wake.notice({**self.record,'payload':'secret'})
    def test_wrong_window_or_conversation_refused(self):
        with self.assertRaises(ValueError):wake.observe(snapshot(title='other'),self.config)
        v=snapshot();v['data']['tree']['children'][0]['children'][0]['name']='unrelated'
        with self.assertRaises(ValueError):wake.observe(v,self.config)
    def test_marker_suffix_or_draft_cannot_authorize_conversation(self):
        for suffix, draft in [('-OTHER', ''), ('-OTHER', self.config['conversationMarker'])]:
            with self.subTest(suffix=suffix,draft=draft):
                v=snapshot(draft=draft)
                v['data']['tree']['children'][0]['children'][0]['name']+=suffix
                with self.assertRaises(ValueError):wake.observe(v,self.config)
    def test_success_and_repeat_do_not_wake_twice(self):
        d=Desktop();r=wake.run(self.record,self.config,d)
        self.assertEqual(r['noticeSubmission'],'OBSERVED')
        self.assertEqual(wake.run(self.record,self.config,None),r);self.assertEqual(d.sends,1)
    def test_unknown_submit_never_replayed(self):
        d=Desktop();d.unknown=True
        r=wake.run(self.record,self.config,d);self.assertEqual(r['noticeSubmission'],'UNKNOWN')
        wake.run(self.record,self.config,None);self.assertEqual(d.sends,1)
    def test_nonempty_draft_preserved(self):
        d=Desktop();d.draft='private draft';r=wake.run(self.record,self.config,d)
        self.assertEqual(r['noticeSubmission'],'NOT_ATTEMPTED');self.assertEqual(d.sends,0)
    def test_submitted_notice_observed_while_stop_replaces_send(self):
        d=Desktop()
        original=d.snapshot
        def processing():
            v=original()
            if d.notice:
                v['data']['tree']['children'][0]['children'][-1]['name']='停止'
            return v
        d.snapshot=processing
        result=wake.run(self.record,self.config,d)
        self.assertEqual(result['noticeSubmission'],'OBSERVED')
        self.assertEqual(d.sends,1)
    def test_busy_ui_is_only_observed_until_idle_before_input(self):
        d=Desktop();original=d.snapshot;seen=[0]
        def settling():
            v=original();seen[0]+=1
            if seen[0]==1:v['data']['tree']['children'][0]['children'][-1]['name']='停止'
            return v
        d.snapshot=settling
        result=wake.run(self.record,self.config,d)
        self.assertEqual(result['noticeSubmission'],'OBSERVED');self.assertEqual(d.sends,1)
    def test_partial_snapshot_refreshes_without_mutation(self):
        cli=object.__new__(wake.ChatGptCli)
        cli.config=dict(self.config,pid=1,processInstance='instance',pollSeconds=.001)
        observed=[0];calls=[]
        def call(args):
            calls.append(args)
            if args[0]=='list-windows':return {'data':[{'id':'w-1','pid':1,'process_instance':'instance','title':'test-chat'}]}
            observed[0]+=1;v=snapshot();v['data']['complete']=observed[0]>1;return v
        cli.call=call
        self.assertTrue(cli.snapshot()['data']['complete'])
        self.assertEqual(observed[0],2)
        self.assertTrue(all(a[0]in['snapshot','list-windows']for a in calls))
    def test_same_message_changed_correlation_denied(self):
        wake.run(self.record,self.config,Desktop());self.record['testId']='CE-WAKE-TEST-other'
        with self.assertRaises(ValueError):wake.run(self.record,self.config,None)

if __name__=='__main__':unittest.main()
