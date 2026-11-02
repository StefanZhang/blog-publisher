import os,unittest
from unittest.mock import patch
import bootstrap as b
import upgrade as u
import test_bootstrap as tb
COMMIT=tb.COMMIT
class UpgradeTests(tb.BootstrapTests):
    # Reuse package/API fixture only, not inherited installer tests.
    def setUp(self):
        super().setUp();self.previous='d'*40
        b.atomic_write(b.path(self.root,u.SERVICE),u.render(self.package,self.previous),0o644)
        b.atomic_write(b.path(self.root,u.TIMER),(self.package/'templates'/(b.UNIT+'.timer')).read_bytes(),0o644)
        b.make_dirs(b.path(self.root,'/usr/local/lib/stefan-blog-cn'))
        os.symlink(b.CURRENT,b.path(self.root,b.BASE+'/active'))
        b.path(self.root,b.BASE+'/.pull.lock').touch()
    def status(self,args):
        if args[-1]==b.UNIT+'.timer':return 'enabled' if args[0]=='is-enabled' else 'active'
        return 'inactive'
    def perform(self,apply=True):return u.upgrade(self.root,self.package,self.previous,COMMIT,'123',self.command,self.status,self.api,apply)
    def test_upgrade_preserves_site_and_schedule(self):
        before={n:b.snapshot(b.path(self.root,n)) for n in [b.VHOST,b.HEALTH,b.BASE+'/active',b.BASE+'/current',u.TIMER]}
        self.assertEqual(self.perform(False)['status'],'validated-only');self.assertEqual(self.calls,[])
        result=self.perform();self.assertEqual(result['status'],'upgraded')
        self.assertEqual(b.path(self.root,u.SERVICE).read_bytes(),u.render(self.package,COMMIT))
        self.assertEqual(before,{n:b.snapshot(b.path(self.root,n)) for n in before})
        self.assertFalse(any('nginx' in ' '.join(c) or 'enable' in c or 'restart' in c for c in self.calls))
        self.assertEqual(self.calls[-1],['/usr/bin/systemctl','start',b.UNIT+'.timer'])
    def test_reload_failure_restores_old_unit(self):
        count=[0]
        def fail(args):
            if 'daemon-reload' in args:count[0]+=1;return count[0]==1
            return False
        self.fail=fail
        with self.assertRaises(RuntimeError):self.perform()
        self.assertEqual(b.path(self.root,u.SERVICE).read_bytes(),u.render(self.package,self.previous))
        self.assertEqual(self.calls[-1],['/usr/bin/systemctl','start',b.UNIT+'.timer'])
    def test_drift_running_service_and_existing_version_fail_before_mutation(self):
        with patch.object(self,'status',return_value='active'):
            with self.assertRaisesRegex(ValueError,'running'):self.perform()
        b.path(self.root,u.SERVICE).write_text('other service')
        with self.assertRaisesRegex(ValueError,'differs'):self.perform()
        self.assertEqual(self.calls,[])
    def test_busy_lock_does_not_stop_timer(self):
        import fcntl
        with b.path(self.root,b.BASE+'/.pull.lock').open('r+') as f:
            fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):self.perform()
        self.assertEqual(self.calls,[])
# Do not re-run bootstrap cases against an already installed fixture.
for name in dir(tb.BootstrapTests):
    if name.startswith('test_') and name not in UpgradeTests.__dict__:setattr(UpgradeTests,name,None)
if __name__=='__main__':unittest.main()
