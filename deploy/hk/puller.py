#!/usr/bin/env python3
"""Anonymous, data-only .cn puller. No GitHub/Cloudflare/SSH credentials or package code execution."""
import concurrent.futures
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit
from routing import (validate_manifest,generate_nginx,file_route,HEX64,MAX_MANIFEST,MAX_FILE,
                     MANIFEST_PATH,CANONICAL,PUBLICATION)

BASE=Path('/var/www/stefanzhang.cn')
REPO='StefanZhang/blog-publisher'
API='https://api.github.com/repos/'+REPO
WORKFLOW='.github/workflows/publish-preview.yml'
TEST_COMMAND=['/usr/bin/sudo','-n','/usr/sbin/nginx','-t']
RELOAD_COMMAND=['/usr/bin/sudo','-n','/usr/bin/systemctl','reload','nginx.service']

def sha(data):return hashlib.sha256(data).hexdigest()
def exact_keys(v,ks):return isinstance(v,dict) and set(v)==set(ks)
def number(v):return isinstance(v,str) and re.fullmatch(r'[1-9][0-9]*',v) is not None
def integer(v):return type(v) is int and v>0

def json_data(data):
    def unique(pairs):
        out={}
        for k,v in pairs:
            if k in out:raise ValueError('Duplicate JSON key')
            out[k]=v
        return out
    return json.loads(data,object_pairs_hook=unique)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

class Fetcher:
    def __init__(self):self.opener=urllib.request.build_opener(NoRedirect())
    @staticmethod
    def allowed(url):
        u=urlsplit(url)
        if u.scheme!='https' or u.username or u.password or u.port or u.fragment:raise ValueError('Unsafe fetch URL')
        if u.hostname=='api.github.com' and u.path.startswith('/repos/'+REPO+'/'):return
        if re.fullmatch(r'[a-f0-9]{8,32}\.stefanzhang-com\.pages\.dev',u.hostname or '') and not u.query:return
        raise ValueError('Untrusted fetch origin')
    def response(self,url):
        self.allowed(url)
        req=urllib.request.Request(url,headers={'User-Agent':'StefanBlog-CN-Puller/1','Accept':'application/vnd.github+json' if url.startswith(API+'/') else '*/*','Accept-Encoding':'identity'})
        return self.opener.open(req,timeout=45)
    def get(self,url,limit):
        with self.response(url) as r:
            if r.status!=200:raise ValueError('Unexpected HTTP '+str(r.status))
            data=r.read(limit+1)
            if len(data)>limit:raise ValueError('Response size limit')
            return data
    def download(self,url,dest,meta):
        count=0;digest=hashlib.sha256()
        with self.response(url) as r,open(dest,'xb') as out:
            if r.status!=200:raise ValueError('Unexpected asset HTTP '+str(r.status))
            while True:
                part=r.read(65536)
                if not part:break
                count+=len(part)
                if count>meta['bytes']:raise ValueError('Asset exceeds expected bytes')
                digest.update(part);out.write(part)
            out.flush();os.fsync(out.fileno())
        if count!=meta['bytes'] or digest.hexdigest()!=meta['sha256']:raise ValueError('Asset byte identity mismatch')
        os.chmod(dest,0o644)

def validate_payload(p):
    ks=['schema','artifactHash','sourceCommit','sourceRun','controllerRun','controllerAttempt','controllerCommit','deploymentURL','manifest','publicationOrigin','canonicalOrigin']
    if not exact_keys(p,ks) or p['schema']!=1 or not isinstance(p['artifactHash'],str) or not HEX64.fullmatch(p['artifactHash']) or not number(p['sourceRun']) or not number(p['controllerRun']) or not integer(p['controllerAttempt']) or p['publicationOrigin']!=PUBLICATION or p['canonicalOrigin']!=CANONICAL:raise ValueError('Invalid publication payload')
    for field in ['sourceCommit','controllerCommit']:
        if not isinstance(p[field],str) or not re.fullmatch(r'[a-f0-9]{40}',p[field]):raise ValueError('Invalid commit identity')
    u=urlsplit(p['deploymentURL'])
    if u.scheme!='https' or not re.fullmatch(r'[a-f0-9]{8,32}\.stefanzhang-com\.pages\.dev',u.hostname or '') or u.port or u.username or u.password or u.path!='' or u.query or u.fragment:raise ValueError('Expected immutable Pages URL')
    m=p['manifest']
    if not exact_keys(m,['path','bytes','sha256']) or m['path']!='/'+MANIFEST_PATH or not integer(m['bytes']) or m['bytes']>MAX_MANIFEST or not isinstance(m['sha256'],str) or not HEX64.fullmatch(m['sha256']):raise ValueError('Invalid manifest receipt')
    return p

def trusted_bot(record):
    creator=record.get('creator') or {};app=record.get('performed_via_github_app')
    # GitHub REST deployments created with GITHUB_TOKEN have bot creator but
    # app=null in observed API responses. A supplied different app is rejected.
    return creator.get('login')=='github-actions[bot]' and creator.get('id')==41898282 and creator.get('type')=='Bot' and (app is None or app.get('slug')=='github-actions')

def discover(fetcher):
    deployments=json_data(fetcher.get(API+'/deployments?environment=cn-pilot&per_page=1',1024*1024))
    if not isinstance(deployments,list) or len(deployments)>1:raise ValueError('Invalid deployment listing')
    if not deployments:return None
    d=deployments[0]
    if not integer(d.get('id')) or d.get('environment')!='cn-pilot' or not trusted_bot(d):raise ValueError('Untrusted deployment creator/environment')
    payload=d.get('payload');payload=json_data(payload) if isinstance(payload,str) else payload
    validate_payload(payload)
    if d.get('sha')!=payload['controllerCommit'] or d.get('ref')!=payload['controllerCommit']:raise ValueError('Deployment/controller commit mismatch')
    statuses=json_data(fetcher.get(API+'/deployments/'+str(d['id'])+'/statuses?per_page=1',1024*1024))
    if not isinstance(statuses,list) or not statuses or statuses[0].get('state')!='success':return None
    if not trusted_bot(statuses[0]):raise ValueError('Untrusted success status creator')
    run=json_data(fetcher.get(API+'/actions/runs/'+payload['controllerRun'],1024*1024))
    if run.get('status')!='completed':return None
    if run.get('conclusion')!='success' or str(run.get('id'))!=payload['controllerRun'] or run.get('run_attempt')!=payload['controllerAttempt'] or run.get('head_branch')!='main' or run.get('head_sha')!=payload['controllerCommit'] or run.get('path','').split('@')[0]!=WORKFLOW or run.get('head_repository',{}).get('full_name')!=REPO or run.get('event') not in ['workflow_dispatch','schedule']:raise ValueError('Controller run failed identity/success policy')
    return {'deploymentId':d['id'],'payload':payload}

def sync_directory(directory):
    fd=os.open(directory,os.O_RDONLY)
    try:os.fsync(fd)
    finally:os.close(fd)

def sync_tree(directory):
    for root,dirs,files in os.walk(directory,topdown=False):
        for name in files:
            with open(Path(root)/name,'rb') as f:os.fsync(f.fileno())
        sync_directory(root)


def atomic_json(file,value):
    fd,name=tempfile.mkstemp(prefix=file.name+'.pending-',dir=file.parent);temp=Path(name)
    with os.fdopen(fd,'w',encoding='utf8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
    os.replace(temp,file);sync_directory(file.parent)

def regular_file(root,relative):
    current=root
    if current.is_symlink():raise ValueError('Symlink release root')
    for part in relative.split('/'):
        current=current/part
        if current.is_symlink():raise ValueError('Symlink in release')
    info=current.lstat()
    if not stat.S_ISREG(info.st_mode):raise ValueError('Nonregular release file')
    return current

def matches(root,relative,meta):
    try:
        file=regular_file(root,relative)
        if file.stat().st_size!=meta['bytes']:return False
        h=hashlib.sha256()
        with open(file,'rb') as f:
            for part in iter(lambda:f.read(65536),b''):h.update(part)
        return h.hexdigest()==meta['sha256']
    except (OSError,ValueError):return False

def active_target(base):
    link=base/'active'
    if not link.is_symlink():raise ValueError('Initial active recovery wrapper must be installed by maintainer')
    target=link.resolve(strict=True);releases=(base/'releases').resolve(strict=True)
    if target.parent!=releases or not target.is_dir():raise ValueError('Active target outside releases')
    return target

def swap_active(base,target):
    temp=base/('.active-next-'+uuid.uuid4().hex)
    try:
        os.symlink(str(target),temp);os.replace(temp,base/'active')
        sync_directory(base)
    finally:
        if temp.is_symlink():temp.unlink()


def finish_journal(base):
    (base/'.activation.json').unlink();sync_directory(base)

def recover_interrupted(base,command):
    file=base/'.activation.json'
    if not file.exists() and not file.is_symlink():return False
    data=json_data(regular_file(base,'.activation.json').read_bytes())
    if not exact_keys(data,['schema','previousDirectory','nextDirectory','artifactHash']) or data['schema']!=1 or not HEX64.fullmatch(data['artifactHash']):raise ValueError('Invalid activation recovery journal')
    for key in ['previousDirectory','nextDirectory']:
        if not isinstance(data[key],str) or not re.fullmatch(r'[A-Za-z0-9_-]+',data[key]):raise ValueError('Invalid recovery directory')
    if data['nextDirectory']!='cn-'+data['artifactHash']:raise ValueError('Invalid recovery identity')
    previous=base/'releases'/data['previousDirectory']
    if previous.is_symlink() or not previous.is_dir() or (base/'releases').is_symlink():raise ValueError('Recovery version unavailable')
    current=active_target(base)
    if current.name not in [data['previousDirectory'],data['nextDirectory']]:raise ValueError('Active was changed by maintainer during incomplete activation; inspect journal')
    if current!=previous:swap_active(base,previous)
    command('test');command('reload');finish_journal(base)
    return True


def run_command(which):
    command=TEST_COMMAND if which=='test' else RELOAD_COMMAND
    result=subprocess.run(command,capture_output=True,text=True,timeout=30)
    if result.returncode:raise RuntimeError('nginx '+which+' failed: '+result.stderr[-1500:])

class LocalTLS(http.client.HTTPSConnection):
    def connect(self):
        sock=socket.create_connection(('127.0.0.1',443),timeout=15)
        self.sock=ssl.create_default_context().wrap_socket(sock,server_hostname='stefanzhang.cn')

def local_get(route,limit):
    conn=LocalTLS('stefanzhang.cn',timeout=15)
    try:
        conn.request('GET',route,headers={'Host':'stefanzhang.cn','Accept-Encoding':'identity','Connection':'close'})
        response=conn.getresponse();body=response.read(limit+1)
        if response.status!=200 or len(body)>limit:raise ValueError('Local HTTPS status/size failure '+route)
        if response.getheader('x-robots-tag','').lower().find('noindex')!=-1:raise ValueError('Unexpected CN noindex')
        return body
    finally:conn.close()

def postcheck(payload,manifest):
    got=local_get('/'+MANIFEST_PATH,payload['manifest']['bytes'])
    if len(got)!=payload['manifest']['bytes'] or sha(got)!=payload['manifest']['sha256']:raise ValueError('Active HTTPS manifest mismatch')
    names=['index.html','rss.xml','search/index.html']
    image=next((n for n in manifest['files'] if n.startswith('images/opt/') and manifest['files'][n]['bytes']<1024*1024),None)
    if image:names.append(image)
    for name in names:
        if name not in manifest['files']:continue
        meta=manifest['files'][name];data=local_get(file_route(name),meta['bytes'])
        if len(data)!=meta['bytes'] or sha(data)!=meta['sha256']:raise ValueError('Active HTTPS file mismatch '+name)
    if not local_get('/healthz',1024).startswith(b'ok '):raise ValueError('Health endpoint body contract mismatch')

def failure_state(base):
    file=base/'.last-failure.json'
    if not file.exists() and not file.is_symlink():return None
    data=json_data(regular_file(base,'.last-failure.json').read_bytes())
    if not exact_keys(data,['schema','deploymentId','controllerRun','failures','retryAfter','error']) or data['schema']!=1 or not integer(data['deploymentId']) or not number(data['controllerRun']) or type(data['failures']) is not int or not 1<=data['failures']<=3 or not isinstance(data['retryAfter'],(int,float)) or not isinstance(data['error'],str):raise ValueError('Invalid local failure state')
    return data

def record_failure(base,receipt,previous,error):
    count=min(3,previous['failures']+1) if previous and previous['deploymentId']==receipt['deploymentId'] else 1
    atomic_json(base/'.last-failure.json',{'schema':1,'deploymentId':receipt['deploymentId'],'controllerRun':receipt['payload']['controllerRun'],'failures':count,'retryAfter':time.time()+[1800,7200,21600][count-1],'error':str(error)[:300]})

def clear_failure(base):
    file=base/'.last-failure.json'
    if file.exists() or file.is_symlink():file.unlink();sync_directory(base)

def discard_current_stage(stage,releases):
    # Only the mkdtemp path from this invocation is eligible. No glob cleanup.
    if stage.parent!=releases or not stage.name.startswith('.building-') or stage.is_symlink():raise ValueError('Refuse unsafe failed-stage cleanup')
    shutil.rmtree(stage);sync_directory(releases)


def pull_once(base=BASE,fetcher=None,command=run_command,verify=postcheck):
    fetcher=fetcher or Fetcher();base=Path(base)
    if base.is_symlink() or not base.is_dir():raise ValueError('Maintainer must initialize fixed site directory')
    base=base.resolve(strict=True)
    # Only our site lock is taken; never touch the previous WP current pointer.
    lockfd=os.open(base/'.pull.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(lockfd,'r+') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return {'status':'locked'}
        recover_interrupted(base,command)
        receipt=discover(fetcher)
        if receipt is None:return {'status':'waiting'}
        previous=failure_state(base)
        if previous and previous['deploymentId']==receipt['deploymentId'] and time.time()<previous['retryAfter']:
            raise RuntimeError('Deployment '+str(receipt['deploymentId'])+' remains failed; retry after '+str(int(previous['retryAfter']))+': '+previous['error'])
        try:
            result=install_receipt(base,fetcher,receipt,command,verify)
            clear_failure(base)
            return result
        except Exception as error:
            record_failure(base,receipt,previous,error)
            raise

def install_receipt(base,fetcher,receipt,command,verify):
    """Called only while pull_once holds the site lock."""
    p=receipt['payload'];old=active_target(base)
    old_receipt=None
    try:old_receipt=json_data(regular_file(old,'receipt.json').read_bytes())
    except (OSError,ValueError):pass
    if old_receipt and old_receipt.get('payload',{}).get('artifactHash')==p['artifactHash'] and old_receipt.get('payload',{}).get('manifest')==p['manifest']:
        return {'status':'unchanged','artifactHash':p['artifactHash']}
    manifest_data=fetcher.get(p['deploymentURL'].rstrip('/')+'/'+MANIFEST_PATH,p['manifest']['bytes'])
    if len(manifest_data)!=p['manifest']['bytes'] or sha(manifest_data)!=p['manifest']['sha256']:raise ValueError('Manifest receipt SHA/bytes mismatch')
    manifest=json_data(manifest_data);total=validate_manifest(manifest)
    releases=base/'releases'
    if releases.is_symlink():raise ValueError('Symlink releases directory')
    final=releases/('cn-'+p['artifactHash'])
    conf=generate_nginx(manifest,final/'site')
    stage=None
    if final.exists():
        if final.is_symlink():raise ValueError('Symlink version directory')
        for name,meta in manifest['files'].items():
            if not matches(final/'site',name,meta):raise ValueError('Existing version differs; refuse overwrite')
        if regular_file(final/'site',MANIFEST_PATH).read_bytes()!=manifest_data or regular_file(final,'nginx/http.conf').read_text()!=conf[0] or regular_file(final,'nginx/server.conf').read_text()!=conf[1]:raise ValueError('Existing version metadata/config differs')
    else:
        if shutil.disk_usage(releases).free<total+128*1024*1024:raise ValueError('Insufficient disk space; no pruning is automatic')
        stage=Path(tempfile.mkdtemp(prefix='.building-',dir=releases))
        os.chmod(stage,0o755);(stage/'site').mkdir(mode=0o755)
        def obtain(item):
            name,meta=item;dest=stage/'site'/name;dest.parent.mkdir(parents=True,exist_ok=True)
            if matches(old/'site',name,meta):
                shutil.copyfile(regular_file(old/'site',name),dest)
                if not matches(stage/'site',name,meta):raise ValueError('Cached file changed while copying')
                os.chmod(dest,0o644)
            else:fetcher.download(p['deploymentURL'].rstrip('/')+file_route(name),dest,meta)
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:list(pool.map(obtain,manifest['files'].items()))
            target=stage/'site'/MANIFEST_PATH;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(manifest_data);os.chmod(target,0o644)
            (stage/'nginx').mkdir();(stage/'nginx/http.conf').write_text(conf[0]);(stage/'nginx/server.conf').write_text(conf[1])
            atomic_json(stage/'receipt.json',receipt)
            for directory,dirs,files in os.walk(stage):
                os.chmod(directory,0o755)
                for file in files:os.chmod(Path(directory)/file,0o644)
            sync_tree(stage);os.rename(stage,final);sync_directory(releases)
        except Exception:
            # Remove only this invocation's incomplete stage, never releases.
            if stage.exists():discard_current_stage(stage,releases)
            raise
    switched=False
    atomic_json(base/'.activation.json',{'schema':1,'previousDirectory':old.name,'nextDirectory':final.name,'artifactHash':p['artifactHash']})
    try:
        switched=True;swap_active(base,final);command('test');command('reload')
        last=None
        for attempt in range(3):
            try:verify(p,manifest);last=None;break
            except Exception as error:last=error;time.sleep(1)
        if last:raise last
        atomic_json(base/'last-success.json',{'deploymentId':receipt['deploymentId'],'artifactHash':p['artifactHash'],'controllerRun':p['controllerRun'],'activatedAt':time.time(),'directory':str(final)})
        finish_journal(base)
    except Exception as error:
        if switched:
            swap_active(base,old)
            try:command('test');command('reload');finish_journal(base)
            except Exception as rollback_error:raise RuntimeError('Deployment failed and rollback reload failed; active restored to '+str(old)+': '+str(rollback_error)) from error
        elif (base/'.activation.json').exists():finish_journal(base)
        raise RuntimeError('Deployment failed; previous active restored: '+str(error)) from error
    return {'status':'deployed','artifactHash':p['artifactHash'],'files':len(manifest['files'])+1,'directory':str(final)}

def main():
    if len(sys.argv)!=1:raise ValueError('No online origin/root overrides are supported')
    result=pull_once()
    if result['status']=='deployed':print(json.dumps(result))
if __name__=='__main__':
    try:main()
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
