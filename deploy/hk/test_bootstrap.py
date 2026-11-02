import copy
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch
import bootstrap as b
from site_health import active_homepage

COMMIT='c'*40
class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()/'root';self.root.mkdir();self.package=Path(self.tmp.name)/'package';shutil.copytree(Path(__file__).parent,self.package,ignore=shutil.ignore_patterns('__pycache__'))
        for name,source in [(b.VHOST,'legacy-vhost.conf'),(b.HEALTH,'legacy-healthcheck.sh')]:
            p=b.path(self.root,name);p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((self.package/'fixtures'/source).read_bytes())
        main=b.path(self.root,'/etc/nginx/nginx.conf');main.write_text('http { include /etc/nginx/conf.d/*.conf; }\n')
        self.legacy=b.path(self.root,b.BASE+'/'+b.CURRENT);self.legacy.mkdir(parents=True);(self.legacy/'index.html').write_bytes(b'<!doctype html><html>preserved</html>')
        os.symlink(b.CURRENT,b.path(self.root,b.BASE+'/current'));self.calls=[];self.api_calls=[];self.bad_run={};self.fail=None
    def tearDown(self):self.tmp.cleanup()
    def api(self,endpoint):
        self.api_calls.append(endpoint)
        if endpoint.startswith('commits/'):return {'sha':COMMIT,'commit':{'tree':{'sha':'a'*40}}}
        if endpoint.startswith('compare/'):return {'status':'identical','merge_base_commit':{'sha':COMMIT}}
        if endpoint.startswith('actions/'):
            return {'id':123,'head_sha':COMMIT,'head_branch':'main','event':'push','path':'.github/workflows/check.yml','status':'completed','conclusion':'success','head_repository':{'full_name':b.REPO},**self.bad_run}
        return {'sha':'a'*40,'truncated':False,'tree':[{'path':'deploy/hk/'+p.relative_to(self.package).as_posix(),'mode':'100644','type':'blob','sha':b.git_blob(p.read_bytes())} for p in self.package.rglob('*') if p.is_file() and '__pycache__' not in p.parts]}
    def status(self,args):
        unit=args[-1]
        if unit=='static-node-health.timer':return 'active' if args[0]=='is-active' else 'enabled'
        if args[0]=='show':return 'not-found'
        return 'disabled' if args[0]=='is-enabled' else 'inactive'
    def command(self,args):
        self.calls.append(args)
        if self.fail and self.fail(args):raise RuntimeError('injected command failure')
        return ''
    def install(self,apply=True):return b.install(self.root,self.package,COMMIT,'123',self.command,self.status,self.api,apply)
    def test_validation_is_read_only_and_ci_identity_is_exact(self):
        r=self.install(False);self.assertEqual(r['status'],'validated-only');self.assertEqual(len(self.api_calls),4)
        self.assertFalse(b.path(self.root,b.BASE+'/active').exists());self.assertFalse(b.path(self.root,b.BACKUPS).exists())
        for field,value in [('event','pull_request'),('conclusion','failure'),('head_sha','d'*40),('head_branch','other'),('path','.github/workflows/evil.yml')]:
            self.bad_run={field:value}
            with self.assertRaises(ValueError):self.install()
    def test_success_keeps_legacy_bytes_and_timer_disabled_even_with_umask077(self):
        before=active_homepage(b.path(self.root,b.BASE));old=os.umask(0o077)
        try:r=self.install()
        finally:os.umask(old)
        self.assertEqual(r['status'],'installed-disabled');self.assertEqual(active_homepage(b.path(self.root,b.BASE)),before)
        self.assertEqual(os.readlink(b.path(self.root,b.BASE+'/current')),b.CURRENT)
        program=b.path(self.root,'/usr/local/lib/stefan-blog-cn/'+COMMIT)
        self.assertEqual(stat.S_IMODE(program.stat().st_mode),0o755);self.assertEqual(stat.S_IMODE(program.parent.stat().st_mode),0o755)
        self.assertFalse(any('enable' in c or 'start' in c for c in self.calls))
        self.assertIn(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/sudo','-n','/usr/sbin/nginx','-t'],self.calls)
        self.assertIn(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/sudo','-n','/usr/bin/systemctl','reload','nginx.service'],self.calls)
        health=b.path(self.root,b.HEALTH).read_text()
        self.assertIn('$1 != \"static-node-health.service\" && $1 != \"stefan-blog-cn-pull.service\"',health)
        for retained in ['root_usage >= 85','memory_available_kib < 65536','swapon --noheadings','systemctl is-active --quiet nginx']:self.assertIn(retained,health)
        service=b.path(self.root,'/etc/systemd/system/'+b.UNIT+'.service').read_text();self.assertNotIn('NoNewPrivileges=true',service);self.assertIn('ProtectSystem=full',service)
        b.restore(self.root,Path(r['backup']),self.command)
        self.assertEqual(active_homepage(b.path(self.root,b.BASE)),before)
        for name,expected in b.EXPECTED.items():self.assertEqual(b.digest(b.path(self.root,name).read_bytes()),expected)
    def test_live_includes_are_written_only_after_complete_wrapper(self):
        write=b.atomic_write;seen=[]
        def check(target,data,mode,*args,**kwargs):
            if target==b.path(self.root,b.VHOST):
                seen.append(True)
                self.assertTrue(b.path(self.root,b.BASE+'/active/nginx/server.conf').is_file())
                self.assertEqual(active_homepage(b.path(self.root,b.BASE)),(self.legacy/'index.html').read_bytes())
            return write(target,data,mode,*args,**kwargs)
        with patch('bootstrap.atomic_write',side_effect=check):self.install()
        self.assertEqual(seen,[True])
    def test_mid_install_failure_restores_original_configs(self):
        once=[False]
        def bad(args):
            if args[0]=='/usr/sbin/runuser' and not once[0]:once[0]=True;return True
            return False
        self.fail=bad
        with self.assertRaisesRegex(RuntimeError,'original configuration restored'):self.install()
        for name,expected in b.EXPECTED.items():self.assertEqual(b.digest(b.path(self.root,name).read_bytes()),expected)
        self.assertFalse(b.path(self.root,b.BASE+'/active').is_symlink());self.assertTrue((self.legacy/'index.html').exists())
    def test_changed_baseline_or_git_bytes_refuse_before_installation(self):
        p=b.path(self.root,b.VHOST);p.write_text(p.read_text()+'# maintainer change\n')
        with self.assertRaisesRegex(ValueError,'CAS baseline changed'):self.install()
        self.assertFalse(b.path(self.root,b.BACKUPS).exists())
        api=self.api
        def corrupt(endpoint):
            result=api(endpoint)
            if endpoint.startswith('git/trees/'):result['tree'][0]['sha']='0'*40
            return result
        with self.assertRaisesRegex(ValueError,'Git blob mismatch'):b.verify_package(self.package,COMMIT,'123',corrupt)
    def test_rollback_refuses_concurrent_changes_or_corrupted_backup(self):
        r=self.install();backup=Path(r['backup']);vhost=b.path(self.root,b.VHOST);installed=vhost.read_bytes();vhost.write_bytes(b'other maintainer')
        with self.assertRaisesRegex(ValueError,'Concurrent change'):b.restore(self.root,backup,self.command)
        self.assertEqual(vhost.read_bytes(),b'other maintainer');self.assertTrue(b.path(self.root,b.BASE+'/active').is_symlink())
        vhost.write_bytes(installed);j=json.loads((backup/'installation.json').read_text());(backup/j['files'][b.VHOST]['backup']).write_bytes(b'broken')
        with self.assertRaisesRegex(ValueError,'Backup hash mismatch'):b.restore(self.root,backup,self.command)
        self.assertEqual(vhost.read_bytes(),installed)

if __name__=='__main__':unittest.main()
