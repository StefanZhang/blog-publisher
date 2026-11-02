#!/usr/bin/env python3
"""One-time, fixed-commit HK bootstrap. Default is validation only; never enables publication."""
import argparse
import base64
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import stat
import subprocess
import tempfile
import urllib.request

REPO='StefanZhang/blog-publisher'
API='https://api.github.com/repos/'+REPO
BASE='/var/www/stefanzhang.cn'
CURRENT='releases/static-20261101T205114Z'
VHOST='/etc/nginx/sites-available/stefanzhang.cn'
HEALTH='/usr/local/sbin/static-node-healthcheck'
BACKUPS='/var/backups/stefanzhang-cn'
EXPECTED={VHOST:'5fb37954e536e13683ff8dbf5b64a9279fb28eed65c6efb403a7cbc50ae8f917',HEALTH:'0364a8cedc5e335adf8e52c7f48f8be3e70061617e0120cbf349601e2515e1fb'}
UNIT='stefan-blog-cn-pull'
PROGRAM_FILES=['bootstrap.py','puller.py','routing.py','site_health.py']
OLD_UNITS=['static-mirror-check.timer','static-mirror-check.service','static-mirror-force.timer','static-mirror-force.service']
OLD_CURL="""if ! curl --fail --silent --show-error --max-time 5 \\
  --header 'Host: stefanzhang.cn' http://127.0.0.1/ >/dev/null; then"""

def digest(data):return hashlib.sha256(data).hexdigest()
def git_blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def path(root,name):return Path(root)/name.lstrip('/')
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=45).stdout.strip()
def state(args):return subprocess.run(['/usr/bin/systemctl',*args],capture_output=True,text=True,timeout=15).stdout.strip()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

def api_json(endpoint):
    req=urllib.request.Request(API+'/'+endpoint,headers={'Accept':'application/vnd.github+json','User-Agent':'StefanBlog-HK-Bootstrap/1'})
    with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as response:
        if response.status!=200:raise ValueError('GitHub identity request failed')
        data=response.read(8*1024*1024+1)
        if len(data)>8*1024*1024:raise ValueError('GitHub response limit')
        return json.loads(data)

def verify_package(package,commit,ci_run,api=api_json):
    if not re.fullmatch(r'[a-f0-9]{40}',commit) or not re.fullmatch(r'[1-9][0-9]*',str(ci_run)):raise ValueError('Exact commit and CI run are required')
    c=api('commits/'+commit)
    if c.get('sha')!=commit:raise ValueError('Commit identity mismatch')
    comparison=api('compare/'+commit+'...main')
    if comparison.get('status') not in ['ahead','identical'] or comparison.get('merge_base_commit',{}).get('sha')!=commit:raise ValueError('Commit is not merged into main')
    r=api('actions/runs/'+str(ci_run))
    if str(r.get('id'))!=str(ci_run) or r.get('head_sha')!=commit or r.get('head_branch')!='main' or r.get('event')!='push' or r.get('path')!='.github/workflows/check.yml' or r.get('status')!='completed' or r.get('conclusion')!='success' or r.get('head_repository',{}).get('full_name')!=REPO:raise ValueError('Exact main push CI did not succeed')
    tree_sha=c.get('commit',{}).get('tree',{}).get('sha')
    if not isinstance(tree_sha,str) or not re.fullmatch(r'[a-f0-9]{40}',tree_sha):raise ValueError('Invalid Git tree identity')
    tree=api('git/trees/'+tree_sha+'?recursive=1')
    if tree.get('truncated') or tree.get('sha')!=tree_sha:raise ValueError('Incomplete Git tree')
    expected={e['path'][10:]:e for e in tree.get('tree',[]) if e.get('path','').startswith('deploy/hk/') and e.get('type')!='tree'}
    actual={p.relative_to(package).as_posix() for p in Path(package).rglob('*') if p.is_file() and '__pycache__' not in p.parts}
    if set(expected)!=actual or not set(PROGRAM_FILES).issubset(actual):raise ValueError('Package file set differs from the trusted commit')
    for name,e in expected.items():
        f=Path(package)/name
        if e.get('mode') not in ['100644','100755'] or e.get('type')!='blob' or f.is_symlink() or git_blob(f.read_bytes())!=e.get('sha'):raise ValueError('Package Git blob mismatch: '+name)
    return {'commit':commit,'ciRun':str(ci_run)}

def render_vhost(old):
    marker='    root '+BASE+'/current;\n'
    if old.count(marker)!=1 or not old.endswith('}\n'):raise ValueError('Unsupported audited vhost structure')
    prefix,body=old.split(marker);body=marker+body[:-2]
    common=[]
    for line in ['    charset utf-8;','    access_log /var/log/nginx/stefanzhang.cn.access.log;','    error_log /var/log/nginx/stefanzhang.cn.error.log warn;','    add_header Strict-Transport-Security "max-age=604800" always;']:
        if body.count(line)!=1:raise ValueError('Missing shared vhost directive')
        body=body.replace(line+'\n','');common.append(line)
    prefix=prefix.replace('return 301 https://$host$request_uri;','return 301 https://stefanzhang.cn$request_uri;')
    new=prefix+'\n'.join(common)+'\n    if ($host = www.stefanzhang.cn) { return 301 https://stefanzhang.cn$request_uri; }\n    include '+BASE+'/active/nginx/server.conf;\n}\n'
    return new,body.replace(BASE+'/current',BASE+'/'+CURRENT)

def planned_files(package,commit,vhost,health):
    program='/usr/local/lib/stefan-blog-cn/'+commit;wrapper=BASE+'/releases/legacy-'+commit[:12]
    new_vhost,legacy=render_vhost(vhost)
    if health.count(OLD_CURL)!=1:raise ValueError('Unsupported audited healthcheck structure')
    health=health.replace(OLD_CURL,'if ! /usr/bin/env -u PYTHONPATH -u PYTHONHOME PYTHONNOUSERSITE=1 /usr/bin/python3 '+program+'/site_health.py; then')
    # A failed updater preserves a working previous website; keep update errors
    # in its own unit/journal, without turning availability monitoring red.
    old_filter="awk '$1 != \"static-node-health.service\" {print $1}'"
    new_filter="awk '$1 != \"static-node-health.service\" && $1 != \"stefan-blog-cn-pull.service\" {print $1}'"
    if health.count(old_filter)!=1:raise ValueError('Unsupported audited failed-unit filter')
    health=health.replace(old_filter,new_filter)
    out={VHOST:(new_vhost.encode(),0o644),HEALTH:(health.encode(),0o755),'/etc/nginx/conf.d/20-stefanzhang-cn-delivery.conf':(('include '+BASE+'/active/nginx/http.conf;\n').encode(),0o644),wrapper+'/nginx/http.conf':(b'# Legacy wrapper has no delivery maps.\n',0o644),wrapper+'/nginx/server.conf':(legacy.encode(),0o644)}
    for name in PROGRAM_FILES:out[program+'/'+name]=((Path(package)/name).read_bytes(),0o644)
    for name in [UNIT+'.service',UNIT+'.timer']:
        text=(Path(package)/'templates'/name).read_text().replace('@PROGRAM@',program)
        out['/etc/systemd/system/'+name]=(text.encode(),0o644)
    return out,{wrapper+'/site':'../'+Path(CURRENT).name,BASE+'/active':'releases/legacy-'+commit[:12]}

def ordinary(root,name):
    p=path(root,name)
    if p.is_symlink() or not p.is_file():raise ValueError('Expected ordinary audited file: '+name)
    return p

def preflight(root,command=run,status=state):
    if os.readlink(path(root,BASE+'/current'))!=CURRENT:raise ValueError('Current WordPress release changed')
    for name,sha in EXPECTED.items():
        if digest(ordinary(root,name).read_bytes())!=sha:raise ValueError('CAS baseline changed: '+name)
    if path(root,BASE+'/active').exists() or path(root,BASE+'/active').is_symlink():raise ValueError('Bootstrap active already exists; use the existing controller')
    if not path(root,BASE+'/'+CURRENT+'/index.html').is_file():raise ValueError('Preserved homepage missing')
    main=ordinary(root,'/etc/nginx/nginx.conf').read_text()
    if 'include /etc/nginx/conf.d/*.conf;' not in main:raise ValueError('Nginx http conf.d include must already exist')
    for unit in OLD_UNITS:
        if status(['show','-p','LoadState','--value',unit])!='not-found':raise ValueError('Legacy writer unit still installed: '+unit)
    if status(['is-active','static-node-health.timer'])!='active' or status(['is-enabled','static-node-health.timer'])!='enabled':raise ValueError('Existing health timer changed')
    for suffix in ['service','timer']:
        if status(['show','-p','LoadState','--value',UNIT+'.'+suffix])!='not-found':raise ValueError('Receiver already installed')
    command(['/usr/sbin/nginx','-t'])

def make_dirs(target):
    missing=[];current=target
    while not current.exists():missing.append(current);current=current.parent
    for directory in reversed(missing):
        directory.mkdir();os.chmod(directory,0o755)
        if os.geteuid()==0:os.chown(directory,0,0)
        parent=os.open(directory.parent,os.O_RDONLY)
        try:os.fsync(parent)
        finally:os.close(parent)


def atomic_write(target,data,mode,uid=0,gid=0):
    make_dirs(target.parent)
    fd,tmp=tempfile.mkstemp(prefix='.bootstrap-',dir=target.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data);f.flush();os.fchmod(f.fileno(),mode)
            if os.geteuid()==0:os.fchown(f.fileno(),uid,gid)
            os.fsync(f.fileno())
        os.replace(tmp,target)
        directory=os.open(target.parent,os.O_RDONLY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def save_journal(backup,journal):atomic_write(backup/'installation.json',(json.dumps(journal,indent=2)+'\n').encode(),0o600)

def snapshot(target):
    if target.is_symlink():return {'kind':'link','target':os.readlink(target)}
    if not target.exists():return {'kind':'absent'}
    if not target.is_file():raise ValueError('Unexpected non-file installation target')
    info=target.stat();return {'kind':'file','sha256':digest(target.read_bytes()),'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}

def same(current,expected):
    return current['kind']==expected['kind'] and (current['kind']=='absent' or current.get('target')==expected.get('target') and current.get('sha256')==expected.get('sha256'))

def restore(root,backup,command=run):
    if (backup/'installation.json').is_symlink():raise ValueError('Invalid backup journal')
    j=json.loads((backup/'installation.json').read_text());errors=[]
    commit=j.get('commit','')
    if j.get('schema')!=1 or not re.fullmatch(r'[a-f0-9]{40}',commit):raise ValueError('Invalid backup identity')
    program='/usr/local/lib/stefan-blog-cn/'+commit;wrapper=BASE+'/releases/legacy-'+commit[:12]
    allowed={VHOST,HEALTH,'/etc/nginx/conf.d/20-stefanzhang-cn-delivery.conf',wrapper+'/nginx/http.conf',wrapper+'/nginx/server.conf',wrapper+'/site',BASE+'/active',*{program+'/'+n for n in PROGRAM_FILES},*{'/etc/systemd/system/'+UNIT+'.'+s for s in ['service','timer']}}
    if set(j.get('files',{}))!=allowed:raise ValueError('Backup target set differs from this fixed installer')
    for name,item in j['files'].items():
        if item['backup'] is not None and not re.fullmatch(r'file-[0-9]+',item['backup']):raise ValueError('Unsafe backup file path')
        current=snapshot(path(root,name))
        if not same(current,item['before']) and not same(current,item['after']):raise ValueError('Concurrent change; rollback refused before writing: '+name)
        if item['before']['kind']=='file' and digest((backup/item['backup']).read_bytes())!=item['before']['sha256']:raise ValueError('Backup hash mismatch')
    references=[VHOST,HEALTH,'/etc/nginx/conf.d/20-stefanzhang-cn-delivery.conf']
    order=references+[n for n in reversed(j['files']) if n not in references]
    for name in order:
        item=j['files'][name]
        p=path(root,name);current=snapshot(p)
        if same(current,item['before']):continue
        if not same(current,item['after']):errors.append('Concurrent change: '+name);continue
        before=item['before']
        if before['kind']=='absent':p.unlink()
        elif before['kind']=='file':
            data=(backup/item['backup']).read_bytes()
            if digest(data)!=before['sha256']:errors.append('Backup hash mismatch: '+name);continue
            atomic_write(p,data,before['mode'],before['uid'],before['gid'])
        else:raise ValueError('Unexpected pre-bootstrap symlink')
    # Do not recursively delete version or legacy directories. Empty directories
    # are harmless and preserve diagnostic evidence if an interruption occurred.
    command(['/usr/bin/systemctl','daemon-reload']);command(['/usr/sbin/nginx','-t']);command(['/usr/bin/systemctl','reload','nginx.service'])
    j['phase']='rollback-incomplete' if errors else 'rolled-back';save_journal(backup,j)
    if errors:raise RuntimeError('; '.join(errors))

def install(root,package,commit,ci_run,command=run,status=state,api=api_json,apply=False):
    root=Path(root);package=Path(package)
    identity=verify_package(package,commit,ci_run,api);preflight(root,command,status)
    files,links=planned_files(package,commit,path(root,VHOST).read_text(),path(root,HEALTH).read_text())
    for name in [*files,*links]:
        current=snapshot(path(root,name))
        if name not in EXPECTED and current['kind']!='absent':raise ValueError('New installation target already exists: '+name)
    for directory in ['/usr/local/lib/stefan-blog-cn','/usr/local/lib/stefan-blog-cn/'+commit,BASE+'/releases/legacy-'+commit[:12],BASE+'/releases/legacy-'+commit[:12]+'/nginx']:
        p=path(root,directory)
        if p.is_symlink() or p.exists() and (not p.is_dir() or os.geteuid()==0 and (p.stat().st_uid!=0 or stat.S_IMODE(p.stat().st_mode)&0o022)):raise ValueError('Untrusted installation directory: '+directory)
    if not apply:return {'status':'validated-only',**identity,'files':len(files),'links':len(links),'timer':'will-remain-disabled'}
    backup=path(root,BACKUPS)/('bootstrap-'+commit[:12]+'-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True,mode=0o700);j={'schema':1,**identity,'phase':'prepared','files':{}}
    for i,(name,(data,mode)) in enumerate(files.items()):
        before=snapshot(path(root,name));item={'before':before,'after':{'kind':'file','sha256':digest(data)},'backup':None}
        if before['kind']=='file':
            item['backup']='file-'+str(i);atomic_write(backup/item['backup'],path(root,name).read_bytes(),0o600)
        j['files'][name]=item
    for name,target in links.items():j['files'][name]={'before':{'kind':'absent'},'after':{'kind':'link','target':target},'backup':None}
    save_journal(backup,j)
    try:
        # Version and wrapper files precede any vhost/health references to them.
        references=[VHOST,HEALTH,'/etc/nginx/conf.d/20-stefanzhang-cn-delivery.conf']
        def write_file(name):
            if not same(snapshot(path(root,name)),j['files'][name]['before']):raise ValueError('CAS changed during install: '+name)
            data,mode=files[name];atomic_write(path(root,name),data,mode)
        for name in files:
            if name not in references:write_file(name)
        # Establish a complete legacy wrapper before changing any live include.
        # A reboot between the next writes still has resolvable old-site paths.
        for name,target in links.items():
            if snapshot(path(root,name))['kind']!='absent':raise ValueError('CAS link changed during install')
            make_dirs(path(root,name).parent);os.symlink(target,path(root,name))
            directory=os.open(path(root,name).parent,os.O_RDONLY)
            try:os.fsync(directory)
            finally:os.close(directory)
        for name in references:write_file(name)
        program='/usr/local/lib/stefan-blog-cn/'+commit
        for file in PROGRAM_FILES:command(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/test','-r',program+'/'+file])
        for directory in [BASE,BASE+'/releases']:command(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/test','-w',directory])
        command(['/usr/bin/systemctl','daemon-reload'])
        command(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/sudo','-n','/usr/sbin/nginx','-t'])
        command(['/usr/sbin/runuser','-u','stefan','--','/usr/bin/sudo','-n','/usr/bin/systemctl','reload','nginx.service'])
        command(['/usr/bin/env','-u','PYTHONPATH','-u','PYTHONHOME','PYTHONNOUSERSITE=1','/usr/bin/python3','/usr/local/lib/stefan-blog-cn/'+commit+'/site_health.py'])
        command([HEALTH])
        for suffix in ['service','timer']:
            if status(['is-active',UNIT+'.'+suffix]) not in ['inactive','unknown']:raise ValueError('Bootstrap must not start publication')
        if status(['is-enabled',UNIT+'.timer'])!='disabled':raise ValueError('Bootstrap must leave timer disabled')
        if status(['is-active','static-node-health.timer'])!='active' or status(['is-enabled','static-node-health.timer'])!='enabled':raise ValueError('Health timer changed')
        if os.readlink(path(root,BASE+'/current'))!=CURRENT:raise ValueError('Legacy current changed')
        j['phase']='installed-disabled';save_journal(backup,j)
        return {'status':j['phase'],**identity,'backup':str(backup),'current':CURRENT}
    except Exception as error:
        try:restore(root,backup,command)
        except Exception as rollback_error:raise RuntimeError('Bootstrap failed; rollback needs inspection: '+str(rollback_error)+'; backup='+str(backup)) from error
        raise RuntimeError('Bootstrap failed; original configuration restored; backup='+str(backup)+': '+str(error)) from error

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--commit');parser.add_argument('--ci-run');parser.add_argument('--apply',action='store_true');parser.add_argument('--rollback');args=parser.parse_args()
    if os.geteuid()!=0:raise ValueError('Maintainer must run this fixed-commit installer as root')
    if not args.apply and not args.rollback:
        if not args.commit or not args.ci_run:raise ValueError('--commit and --ci-run are required')
        print(json.dumps(install('/',Path(__file__).resolve().parent,args.commit,args.ci_run,apply=False)));return
    site=Path(BASE)
    fd=os.open(site/'.pull.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'r+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        os.fchown(lock.fileno(),pwd.getpwnam('stefan').pw_uid,grp.getgrnam('www-data').gr_gid)
        if args.rollback:
            backup=Path(args.rollback)
            if args.commit or args.ci_run or args.apply or backup.parent!=Path(BACKUPS) or not re.fullmatch(r'bootstrap-[a-f0-9]{12}-[0-9TZ]+',backup.name) or backup.is_symlink() or backup.stat().st_uid!=0:raise ValueError('Use only the root-owned bootstrap backup')
            if state(['is-active',UNIT+'.timer'])=='active' or state(['is-enabled',UNIT+'.timer']) not in ['disabled','not-found',''] or state(['is-active',UNIT+'.service']) not in ['inactive','failed','unknown']:raise ValueError('Stop and disable publication timer before rollback')
            restore('/',backup);print(json.dumps({'status':'rolled-back','backup':str(backup)}))
        else:
            if not args.commit or not args.ci_run:raise ValueError('--commit and --ci-run are required')
            print(json.dumps(install('/',Path(__file__).resolve().parent,args.commit,args.ci_run,apply=args.apply)))
if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
