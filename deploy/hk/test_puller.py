import copy
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit
import routing
import puller

class MemoryFetcher:
    def __init__(self):
        self.bytes={'index.html':b'<h1>home</h1>','404.html':b'<h1>missing</h1>','images/opt/a.webp':b'image bytes'}
        self.manifest={'schema':1,'canonicalOrigin':routing.CANONICAL,'publicationOrigin':routing.PUBLICATION,'headersSHA256':routing.HEADERS_SHA,'files':{k:{'bytes':len(v),'sha256':puller.sha(v)} for k,v in self.bytes.items()},'routing':{'redirects':[{'source':'/old','target':'/','status':301},{'source':'/tag/:slug/page/:page/','target':'/tag/:slug/:page/','status':301}],'attachments':[],'queries':[{'parameter':'p','value':'21','target':'/21/','status':301}]}}
        self.payload={'schema':1,'artifactHash':'a'*64,'sourceCommit':'b'*40,'sourceRun':'123','controllerRun':'456','controllerAttempt':1,'controllerCommit':'c'*40,'deploymentURL':'https://1234abcd.stefanzhang-com.pages.dev','manifest':{},'publicationOrigin':routing.PUBLICATION,'canonicalOrigin':routing.CANONICAL}
        self.refresh();bot={'login':'github-actions[bot]','id':41898282,'type':'Bot'}
        self.deployment={'id':100,'environment':'cn-pilot','sha':'c'*40,'ref':'c'*40,'creator':bot,'performed_via_github_app':None,'payload':self.payload}
        self.statuses=[{'state':'success','creator':bot,'performed_via_github_app':None}]
        self.run={'id':456,'run_attempt':1,'status':'completed','conclusion':'success','head_branch':'main','head_sha':'c'*40,'path':puller.WORKFLOW,'head_repository':{'full_name':puller.REPO},'event':'workflow_dispatch'}
        self.downloads=[];self.corrupt=False
    def refresh(self):
        self.data=json.dumps(self.manifest,ensure_ascii=False).encode();self.payload['manifest']={'path':'/_delivery/manifest.json','bytes':len(self.data),'sha256':puller.sha(self.data)}
    def get(self,url,limit):
        if '/deployments?' in url:data=json.dumps([self.deployment]).encode()
        elif '/statuses?' in url:data=json.dumps(self.statuses).encode()
        elif '/actions/runs/' in url:data=json.dumps(self.run).encode()
        else:data=self.data
        if len(data)>limit:raise ValueError('Size limit')
        return data
    def download(self,url,dest,meta):
        self.downloads.append(url)
        name=next(n for n in self.bytes if self.payload['deploymentURL'].rstrip('/')+routing.file_route(n)==url)
        data=b'corrupt' if self.corrupt else self.bytes[name]
        dest.write_bytes(data)
        if len(data)!=meta['bytes'] or puller.sha(data)!=meta['sha256']:raise ValueError('Asset byte identity mismatch')

class PullerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='cn-puller-');self.root=Path(self.tmp.name).resolve();(self.root/'releases').mkdir();self.old=self.root/'releases'/'legacy-wrapper';self.old.mkdir();(self.old/'site').mkdir();os.symlink(self.old,self.root/'active');self.f=MemoryFetcher();self.commands=[];self.verified=[]
    def tearDown(self):self.tmp.cleanup()
    def run_pull(self,command=None,verify=None):
        return puller.pull_once(self.root,self.f,command or self.commands.append,verify or (lambda p,m:self.verified.append(p['artifactHash'])))
    def test_verified_activation_and_idempotent_skip(self):
        result=self.run_pull();self.assertEqual(result['status'],'deployed');self.assertEqual(self.commands,['test','reload']);self.assertEqual(len(self.f.downloads),3)
        active=(self.root/'active').resolve();self.assertEqual((active/'site/index.html').read_bytes(),self.f.bytes['index.html']);self.assertEqual((active/'site/_delivery/manifest.json').read_bytes(),self.f.data)
        config=(active/'nginx/server.conf').read_text();self.assertIn(str(active/'site'),config);self.assertNotIn('root '+str(self.root/'active'),config);self.assertIn('/var/lib/static-node-monitor/ok',config);self.assertNotIn('add_header X-Robots-Tag',config)
        self.assertEqual(self.run_pull()['status'],'unchanged');self.assertEqual(len(self.f.downloads),3);self.assertTrue(self.old.exists())
    def test_content_workflow_is_explicitly_allowed_but_arbitrary_workflow_is_not(self):
        self.f.run['path']='.github/workflows/publish-content.yml'
        self.assertEqual(self.run_pull()['status'],'deployed')
        self.f.run['path']='.github/workflows/unreviewed.yml'
        self.f.deployment['id']+=1
        with self.assertRaisesRegex(ValueError,'identity'):self.run_pull()
    def test_failure_before_activation_keeps_old(self):
        self.f.corrupt=True
        with self.assertRaisesRegex(ValueError,'identity'):self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(self.commands,[])
    def test_nginx_test_and_reload_failures_restore_old(self):
        for fail in ['test','reload']:
            self.f.deployment['id']+=1
            calls=[]
            def command(which):
                calls.append(which)
                if which==fail and calls.count(fail)==1:raise RuntimeError('injected '+fail)
            with self.assertRaisesRegex(RuntimeError,'previous active restored'):self.run_pull(command=command)
            self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(calls[-2:],['test','reload'])
    def test_postcheck_failure_restores_old(self):
        def bad(p,m):raise RuntimeError('HTTPS mismatch')
        with patch('puller.time.sleep'),self.assertRaisesRegex(RuntimeError,'previous active restored'):self.run_pull(verify=bad)
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(self.commands,['test','reload','test','reload'])
    def test_wrong_health_body_causes_actual_postcheck_rollback(self):
        def local(route,limit):
            if route=='/_delivery/manifest.json':return self.f.data
            if route=='/healthz':self.assertEqual(limit,1024);return b'BROKEN monitor body'
            name=next(n for n in self.f.bytes if routing.file_route(n)==route)
            return self.f.bytes[name]
        with patch('puller.local_get',side_effect=local),patch('puller.time.sleep'),self.assertRaisesRegex(RuntimeError,'Health endpoint body contract mismatch'):
            self.run_pull(verify=puller.postcheck)
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(self.commands,['test','reload','test','reload'])
    def test_no_reuse_without_hash_check_or_through_symlink(self):
        (self.old/'site/index.html').write_bytes(b'corrupt old file');(self.old/'site/images').mkdir();outside=self.root/'outside';outside.mkdir();(outside/'a.webp').write_bytes(self.f.bytes['images/opt/a.webp']);os.symlink(outside,self.old/'site/images/opt')
        self.run_pull();self.assertEqual(len(self.f.downloads),3)
    def test_legacy_wrapper_site_symlink_is_never_reused(self):
        (self.old/'site').rmdir();legacy=self.root/'releases/static-preserved';legacy.mkdir()
        (legacy/'index.html').write_bytes(self.f.bytes['index.html']);os.symlink(legacy,self.old/'site')
        self.run_pull();self.assertEqual(len(self.f.downloads),3)
        self.assertTrue((self.old/'site').is_symlink());self.assertTrue((legacy/'index.html').exists())
    def test_matching_old_bytes_are_reused(self):
        (self.old/'site/index.html').write_bytes(self.f.bytes['index.html']);self.run_pull();self.assertEqual(len(self.f.downloads),2)
    def test_pending_failed_or_wrong_run_never_activates(self):
        self.f.run['status']='in_progress';self.assertEqual(self.run_pull()['status'],'waiting');self.assertEqual(self.f.downloads,[])
        self.f.run['status']='completed'
        for field,value in [('conclusion','failure'),('head_branch','evil'),('run_attempt',2),('path','.github/workflows/evil.yml'),('head_sha','d'*40)]:
            old=self.f.run[field];self.f.run[field]=value
            with self.assertRaises(ValueError):self.run_pull()
            self.f.run[field]=old
        self.assertEqual((self.root/'active').resolve(),self.old)
    def test_wrong_deployment_ref_rejected(self):
        self.f.deployment['ref']='main'
        with self.assertRaises(ValueError):self.run_pull()
    def test_wrong_creator_and_app_rejected(self):
        self.f.deployment['creator']={'login':'StefanZhang','type':'User'}
        with self.assertRaises(ValueError):self.run_pull()
        self.f.deployment['creator']={'login':'github-actions[bot]','id':41898282,'type':'Bot'};self.f.deployment['performed_via_github_app']={'slug':'other'}
        with self.assertRaises(ValueError):self.run_pull()
    def test_bad_manifest_and_unsafe_paths_never_activate(self):
        self.f.payload['manifest']['sha256']='d'*64
        with self.assertRaisesRegex(ValueError,'receipt SHA'):self.run_pull()
        self.f.deployment['id']+=1
        self.f.manifest['files']['../secret']={'bytes':1,'sha256':'e'*64};self.f.refresh()
        with self.assertRaises(ValueError):self.run_pull()
        self.assertEqual(self.commands,[])
    def test_lock_and_existing_tampered_version(self):
        with open(self.root/'.pull.lock','w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);self.assertEqual(self.run_pull()['status'],'locked')
        self.run_pull();current=(self.root/'active').resolve();puller.swap_active(self.root,self.old);(current/'site/index.html').write_bytes(b'bad')
        with self.assertRaisesRegex(ValueError,'refuse overwrite'):self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old)

    def test_state_write_failure_rolls_back_and_does_not_touch_wp_current(self):
        os.symlink(self.old,self.root/'current');real=puller.atomic_json
        def fail(file,value):
            if file.name=='last-success.json':raise OSError('injected disk-full state write')
            return real(file,value)
        with patch('puller.atomic_json',side_effect=fail),self.assertRaisesRegex(RuntimeError,'previous active restored'):
            self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual((self.root/'current').resolve(),self.old)
        self.assertEqual(self.commands,['test','reload','test','reload'])
    def test_rollback_reload_failure_is_reported_not_hidden(self):
        def fail(which):raise RuntimeError('all nginx commands fail')
        with self.assertRaisesRegex(RuntimeError,'rollback reload failed'):self.run_pull(command=fail)
        self.assertEqual((self.root/'active').resolve(),self.old)

    def test_interrupted_activation_recovers_before_network_discovery(self):
        self.run_pull();new=(self.root/'active').resolve()
        puller.atomic_json(self.root/'.activation.json',{'schema':1,'previousDirectory':self.old.name,'nextDirectory':new.name,'artifactHash':self.f.payload['artifactHash']})
        self.commands.clear()
        with patch.object(self.f,'get',side_effect=RuntimeError('network unavailable')),self.assertRaisesRegex(RuntimeError,'network unavailable'):
            self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(self.commands,['test','reload']);self.assertFalse((self.root/'.activation.json').exists())
    def test_unrelated_active_change_is_not_overwritten_by_recovery(self):
        puller.atomic_json(self.root/'.activation.json',{'schema':1,'previousDirectory':'another-old','nextDirectory':'cn-'+'a'*64,'artifactHash':'a'*64})
        (self.root/'releases/another-old').mkdir()
        with self.assertRaisesRegex(ValueError,'changed by maintainer'):self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertEqual(self.commands,[])

    def test_failure_after_symlink_replace_rolls_back(self):
        real=puller.swap_active;count=0
        def fail_after_swap(base,target):
            nonlocal count
            real(base,target);count+=1
            if count==1:raise OSError('injected directory fsync failure after replace')
        with patch('puller.swap_active',side_effect=fail_after_swap),self.assertRaisesRegex(RuntimeError,'previous active restored'):
            self.run_pull()
        self.assertEqual((self.root/'active').resolve(),self.old);self.assertFalse((self.root/'.activation.json').exists())
        self.assertEqual(self.commands,['test','reload'])

    def test_failure_backoff_cleans_only_current_stage_and_new_deployment_can_retry(self):
        kept=self.root/'releases/.building-unrelated';kept.mkdir();(kept/'marker').write_text('keep')
        self.f.corrupt=True
        with patch('puller.time.time',return_value=1000),self.assertRaises(ValueError):self.run_pull()
        count=len(self.f.downloads);state=puller.failure_state(self.root)
        self.assertEqual(state['retryAfter'],2800);self.assertEqual(state['failures'],1)
        self.assertEqual(list((self.root/'releases').glob('.building-*')),[kept])
        with patch('puller.time.time',return_value=1001),self.assertRaisesRegex(RuntimeError,'remains failed'):self.run_pull()
        self.assertEqual(len(self.f.downloads),count);self.assertEqual((self.root/'active').resolve(),self.old)
        self.f.deployment['id']+=1;self.f.corrupt=False
        with patch('puller.time.time',return_value=1002):self.assertEqual(self.run_pull()['status'],'deployed')
        self.assertIsNone(puller.failure_state(self.root));self.assertTrue((kept/'marker').exists());self.assertTrue(self.old.exists())
    def test_repeated_failures_escalate_to_two_and_six_hour_backoff(self):
        self.f.corrupt=True
        for now,count,delay in [(1000,1,1800),(2801,2,7200),(10002,3,21600),(31603,3,21600)]:
            with patch('puller.time.time',return_value=now),self.assertRaises(ValueError):self.run_pull()
            state=puller.failure_state(self.root)
            self.assertEqual(state['failures'],count);self.assertEqual(state['retryAfter'],now+delay)
            self.assertEqual(list((self.root/'releases').glob('.building-*')),[])
        self.assertEqual((self.root/'active').resolve(),self.old)

class PolicyTests(unittest.TestCase):
    def test_fetch_urls_and_duplicate_json(self):
        for bad in ['http://1234abcd.stefanzhang-com.pages.dev/','https://release-preview.stefanzhang-com.pages.dev/','https://1234abcd.stefanzhang-com.pages.dev.evil/x','https://user@1234abcd.stefanzhang-com.pages.dev/','https://api.github.com/repos/evil/repo/x']:
            with self.assertRaises(ValueError):puller.Fetcher.allowed(bad)
        with self.assertRaises(ValueError):puller.json_data(b'{"a":1,"a":2}')

    def test_controller_canonical_origin_and_existing_sudo_interface(self):
        f=MemoryFetcher();self.assertEqual(puller.validate_payload(f.payload),f.payload)
        for suffix in ['/','/path','?x=1','#fragment']:
            candidate=copy.deepcopy(f.payload);candidate['deploymentURL']+=suffix
            with self.assertRaises(ValueError):puller.validate_payload(candidate)
        candidate=copy.deepcopy(f.payload);candidate['deploymentURL']='https://'+'a'*32+'.stefanzhang-com.pages.dev';puller.validate_payload(candidate)
        candidate['deploymentURL']='https://'+'a'*33+'.stefanzhang-com.pages.dev'
        with self.assertRaises(ValueError):puller.validate_payload(candidate)
        with patch('puller.subprocess.run') as run:
            run.return_value.returncode=0;puller.run_command('reload')
            self.assertEqual(run.call_args.args[0],['/usr/bin/sudo','-n','/usr/bin/systemctl','reload','nginx.service'])
            puller.run_command('test');self.assertEqual(run.call_args.args[0],['/usr/bin/sudo','-n','/usr/sbin/nginx','-t'])
        record={'creator':{'login':'github-actions[bot]','id':1,'type':'Bot'}}
        self.assertFalse(puller.trusted_bot(record));record['creator']['id']=41898282;self.assertTrue(puller.trusted_bot(record))
    def test_header_and_nginx_injection_rejected(self):
        f=MemoryFetcher();m=copy.deepcopy(f.manifest);m['headersSHA256']='f'*64
        with self.assertRaises(ValueError):routing.validate_manifest(m)
        m=copy.deepcopy(f.manifest);m['routing']['redirects'][0]['target']='/ok"; return 200 bad; #'
        with self.assertRaises(ValueError):routing.generate_nginx(m,'/var/www/site')
        m=copy.deepcopy(f.manifest);m['routing']['redirects'][0]['target']='/$evil'
        with self.assertRaises(ValueError):routing.generate_nginx(m,'/var/www/site')
        with self.assertRaises(ValueError):routing.generate_nginx(f.manifest,'/tmp/a";bad')

    def test_encoded_newline_and_bad_fragment_rejected(self):
        for route in ['/ok#bad%0aheader','/ok#bad%0D','/a%00','/a/%2e%2e/b','//evil/path','/x#bad%GG']:
            with self.assertRaises(ValueError):routing.safe_route(route,True)
    def test_streamed_bytes_are_bounded_and_hash_checked(self):
        import io
        class Response(io.BytesIO):status=200
        f=puller.Fetcher()
        with tempfile.TemporaryDirectory() as tmp:
            for i,data in enumerate([b'abcd',b'xxx',b'a']):
                with patch.object(f,'response',return_value=Response(data)),self.assertRaises(ValueError):
                    f.download('https://1234abcd.stefanzhang-com.pages.dev/a',Path(tmp)/str(i),{'bytes':3,'sha256':puller.sha(b'abc')})
            with patch.object(f,'response',return_value=Response(b'abc')):
                f.download('https://1234abcd.stefanzhang-com.pages.dev/a',Path(tmp)/'valid',{'bytes':3,'sha256':puller.sha(b'abc')})
            self.assertEqual((Path(tmp)/'valid').read_bytes(),b'abc')
        self.assertIsNone(puller.NoRedirect().redirect_request(None,None,302,'Found',{},'https://evil/'))

    def test_public_synthetic_route_contract(self):
        from fixture_data import synthetic_fixture
        from urllib.parse import unquote
        m,cases=synthetic_fixture();routing.validate_manifest(m)
        for case in cases:
            current=case['url']
            for hop in range(10):
                target=routing.next_redirect(current,m['routing'])
                if target is None:break
                current=target
            self.assertEqual(unquote(current),unquote(case['target']),case['url'])
    def test_path_and_size_limits(self):
        f=MemoryFetcher()
        for p in ['/etc/passwd','x/../z','x\\z','.env','src/private.md','release.json','_worker.js','_delivery/manifest.json']:
            with self.assertRaises(ValueError):routing.safe_file(p)
        f.manifest['files']['index.html']['bytes']=routing.MAX_FILE+1
        with self.assertRaises(ValueError):routing.validate_manifest(f.manifest)

if __name__=='__main__':unittest.main()
