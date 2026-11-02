#!/usr/bin/env python3
"""Upgrade only the receiver's fixed service path; never switch website or Nginx."""
import argparse,contextlib,datetime,fcntl,json,os,re,stat
from pathlib import Path
import bootstrap as b

SERVICE='/etc/systemd/system/'+b.UNIT+'.service'
TIMER='/etc/systemd/system/'+b.UNIT+'.timer'
def render(package,commit):
    return (Path(package)/'templates'/(b.UNIT+'.service')).read_text().replace('@PROGRAM@','/usr/local/lib/stefan-blog-cn/'+commit).encode()
def trusted_file(p):
    if p.is_symlink() or not p.is_file():raise ValueError('Expected ordinary receiver file')
    if os.geteuid()==0 and (p.stat().st_uid!=0 or stat.S_IMODE(p.stat().st_mode)&0o022):raise ValueError('Receiver file is writable by non-root')
    return p.read_bytes()
def upgrade(root,package,previous,commit,ci_run,command=b.run,status=b.state,api=b.api_json,apply=False):
    root=Path(root);package=Path(package)
    if not re.fullmatch('[a-f0-9]{40}',previous) or previous==commit:raise ValueError('Exact distinct previous version required')
    identity=b.verify_package(package,commit,ci_run,api)
    service=b.path(root,SERVICE);old=render(package,previous);new=render(package,commit)
    if trusted_file(service)!=old:raise ValueError('Service differs from expected previous template')
    if trusted_file(b.path(root,TIMER))!=(package/'templates'/(b.UNIT+'.timer')).read_bytes():raise ValueError('Timer differs; this upgrader does not modify schedules')
    if status(['is-active',b.UNIT+'.service']) not in ['inactive','failed']:raise ValueError('Receiver is running; retry later')
    timer_active=status(['is-active',b.UNIT+'.timer'])
    timer_enabled=status(['is-enabled',b.UNIT+'.timer'])
    if timer_active not in ['active','inactive'] or timer_enabled not in ['enabled','disabled']:raise ValueError('Unknown timer state')
    program=b.path(root,'/usr/local/lib/stefan-blog-cn/'+commit)
    if program.exists() or program.is_symlink():raise ValueError('New version directory already exists; inspect previous attempt')
    for p in [program.parent,service.parent]:
        if p.is_symlink() or not p.is_dir() or os.geteuid()==0 and (p.stat().st_uid!=0 or stat.S_IMODE(p.stat().st_mode)&0o022):raise ValueError('Untrusted installation directory')
    active=b.path(root,b.BASE+'/active')
    if not active.is_symlink():raise ValueError('Missing installed website pointer')
    unchanged={name:b.snapshot(b.path(root,name)) for name in [b.VHOST,b.HEALTH,b.BASE+'/active',b.BASE+'/current',TIMER]}
    if not apply:return {'status':'validated-only','previous':previous,**identity,'timer':timer_active}
    # The same pre-existing lock as the non-root puller: no chmod/chown or new lock inode.
    fd=os.open(b.path(root,b.BASE+'/.pull.lock'),os.O_RDWR|os.O_NOFOLLOW)
    with os.fdopen(fd,'r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if trusted_file(service)!=old:raise ValueError('Concurrent service change')
        backup=b.path(root,b.BACKUPS)/('upgrade-'+commit[:12]+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        backup.mkdir(parents=True,mode=0o700)
        b.atomic_write(backup/'previous.service',old,0o600)
        journal={'schema':1,**identity,'previous':previous,'oldServiceSHA256':b.digest(old),'newServiceSHA256':b.digest(new),'timerActive':timer_active,'timerEnabled':timer_enabled,'phase':'prepared'}
        def save():b.atomic_write(backup/'upgrade.json',(json.dumps(journal,indent=2)+'\n').encode(),0o600)
        save();changed=False
        try:
            command(['/usr/bin/systemctl','stop',b.UNIT+'.timer'])
            if status(['is-active',b.UNIT+'.service']) not in ['inactive','failed']:raise ValueError('Receiver started concurrently; retry later')
            for name in b.PROGRAM_FILES:b.atomic_write(program/name,(package/name).read_bytes(),0o644)
            # Validate import/syntax before changing the live unit. No receiver execution.
            command(['/usr/bin/python3','-I','-c','import ast,pathlib,sys; [ast.parse(p.read_text()) for p in pathlib.Path(sys.argv[1]).glob("*.py")]',str(program)])
            if trusted_file(service)!=old:raise ValueError('Concurrent service change before swap')
            b.atomic_write(service,new,0o644);changed=True
            command(['/usr/bin/systemctl','daemon-reload'])
            for name,snap in unchanged.items():
                if b.snapshot(b.path(root,name))!=snap:raise ValueError('Unrelated node state changed: '+name)
            if status(['is-enabled',b.UNIT+'.timer'])!=timer_enabled:raise ValueError('Timer enabled state changed')
            journal['phase']='installed';save()
        except Exception:
            if changed:
                if trusted_file(service)!=new:raise RuntimeError('Concurrent service change; automatic rollback refused')
                b.atomic_write(service,old,0o644);command(['/usr/bin/systemctl','daemon-reload'])
            journal['phase']='rolled-back';save();raise
        finally:
            if timer_active=='active':command(['/usr/bin/systemctl','start',b.UNIT+'.timer'])
        return {'status':'upgraded','previous':previous,**identity,'backup':str(backup),'website':'unchanged','timer':timer_active}

def main():
    p=argparse.ArgumentParser();p.add_argument('--package',required=True);p.add_argument('--previous',required=True);p.add_argument('--commit',required=True);p.add_argument('--ci-run',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
    if os.geteuid()!=0:raise SystemExit('Receiver installation requires root; publication remains unprivileged')
    print(json.dumps(upgrade('/',a.package,a.previous,a.commit,a.ci_run,apply=a.apply)))
if __name__=='__main__':main()
