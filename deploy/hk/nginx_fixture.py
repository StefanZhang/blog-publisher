#!/usr/bin/env python3
"""Isolated real-Nginx routing experiment. Synthetic bytes, never production reload.
Copies only route-shaped dummy files. This proves routing/headers, not artifact identity.
"""
import argparse
import http.client
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import quote,unquote,urlsplit
from routing import generate_nginx,validate_manifest,file_route

def request(port,target):
    u=urlsplit(target);route=quote(u.path,safe="%/;:@&=+$,-_.!~*'()")+('?' + u.query if u.query else '')
    c=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
    try:
        c.request('GET',route,headers={'Host':'stefanzhang.cn','Connection':'close'})
        r=c.getresponse();return r.status,dict(r.getheaders()),r.read()
    finally:c.close()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest');p.add_argument('--cases');p.add_argument('--synthetic',action='store_true');p.add_argument('--work',required=True);p.add_argument('--nginx',default='/usr/sbin/nginx');p.add_argument('--port',type=int,default=18743);args=p.parse_args()
    if not 1024<=args.port<=65535:raise ValueError('Unprivileged localhost port required')
    root=Path(args.work).resolve();root.mkdir(mode=0o755);site=root/'site';site.mkdir()
    if args.synthetic:
        if args.manifest or args.cases:raise ValueError('Synthetic fixture cannot read private manifests/cases')
        from fixture_data import synthetic_fixture
        m,cases=synthetic_fixture()
    else:
        if not args.manifest or not args.cases:raise ValueError('Use --synthetic or both --manifest and --cases')
        m=json.loads(Path(args.manifest).read_text());cases=json.loads(Path(args.cases).read_text())
    validate_manifest(m)
    for name in m['files']:
        dest=site/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes((b'<!doctype html><h1>routing-fixture</h1>' if name.endswith('.html') else b'fixture'))
    h,s=generate_nginx(m,site)
    if args.synthetic:
        # Isolate the readiness file too; never create/write the real monitor path.
        (root/'healthz-body').write_bytes(b'ok synthetic\n')
        s=s.replace('alias /var/lib/static-node-monitor/ok;', 'alias '+str(root/'healthz-body')+';')
    (root/'http.conf').write_text(h);(root/'server.conf').write_text(s)
    conf='\n'.join(['daemon off;','master_process off;','pid '+str(root/'nginx.pid')+';','error_log '+str(root/'error.log')+' info;','events { worker_connections 128; }','http { access_log off; include '+str(root/'http.conf')+'; server { listen 127.0.0.1:'+str(args.port)+'; server_name stefanzhang.cn; absolute_redirect off; include '+str(root/'server.conf')+'; } }'])
    (root/'nginx.conf').write_text(conf)
    tested=subprocess.run([args.nginx,'-t','-c',str(root/'nginx.conf'),'-p',str(root)],capture_output=True,text=True)
    (root/'syntax.txt').write_text(tested.stdout+tested.stderr)
    if tested.returncode:raise RuntimeError(tested.stderr)
    with open(root/'process.log','w') as log:
        process=subprocess.Popen([args.nginx,'-c',str(root/'nginx.conf'),'-p',str(root)],stdout=log,stderr=log)
        results=[]
        try:
            for i in range(30):
                try:request(args.port,'/');break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('Isolated Nginx not listening')
            for case in cases:
                u=case['url'];seen=set();hops=0;failure=None
                for hop in range(10):
                    status,headers,body=request(args.port,u)
                    if status!=301:break
                    location=headers.get('Location',headers.get('location',''));dest=urlsplit(location)
                    if dest.netloc and dest.hostname!='stefanzhang.cn':failure='cross-origin redirect';break
                    if location in seen:failure='redirect loop';break
                    seen.add(location);u=location;hops+=1
                final=urlsplit(u);actual=final.path+('?' +final.query if final.query else '')+('#'+final.fragment if final.fragment else '')
                if status!=case.get('status',200):failure='terminal HTTP '+str(status)
                if unquote(actual)!=unquote(case['target']):failure='target '+actual
                results.append({'url':case['url'],'target':case['target'],'actual':actual,'status':status,'hops':hops,'failure':failure})
            # Real Nginx status/MIME/cache/security assertions on synthetic files.
            checks=[]
            routes=[('/','text/html',None),('/rss.xml','application/xml', 'max-age=1800'),('/search-index.json','application/json','max-age=3600')]
            if args.synthetic:routes.append(('/healthz','text/plain','no-store'))
            for prefix,mime,cache in [('images/opt/','image/','immutable'),('_astro/','', 'immutable'),('og/','image/','max-age=604800')]:
                name=next((n for n in m['files'] if n.startswith(prefix)),None)
                if name:routes.append((file_route(name),mime,cache))
            for route,mime,cache in routes:
                status,headers,body=request(args.port,route);headers={k.lower():v for k,v in headers.items()}
                ok=status==200 and mime in headers.get('content-type','') and (cache is None or cache in headers.get('cache-control','')) and headers.get('x-content-type-options')=='nosniff' and "img-src 'self' data:" in headers.get('content-security-policy','') and 'noindex' not in headers.get('x-robots-tag','')
                if route=='/healthz':ok=ok and body.startswith(b'ok ') and len(body)<=1024
                checks.append({'route':route,'passed':ok,'status':status,'headers':headers})
            for route in ['/__fixture_missing','/.env','/_worker.js','/_headers','/_redirects','/_routes.json']:
                status,headers,body=request(args.port,route);checks.append({'route':route,'passed':status==404,'status':status})
            file_checks=[]
            for name in m['files']:
                status,headers,body=request(args.port,file_route(name))
                expected=b'<!doctype html><h1>routing-fixture</h1>' if name.endswith('.html') else b'fixture'
                file_checks.append({'path':name,'status':status,'passed':status==200 and body==expected})
            result={'kind':'isolated-nginx-routing-with-synthetic-bytes','cases':len(results),'failed':sum(bool(r['failure']) for r in results),'checksFailed':sum(not c['passed'] for c in checks),'files':len(file_checks),'fileChecksFailed':sum(not c['passed'] for c in file_checks),'fileChecks':file_checks,'results':results,'checks':checks}
            (root/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['results','checks','fileChecks']}))
            if result['failed'] or result['checksFailed'] or result['fileChecksFailed']:raise RuntimeError('Nginx routing/header assertions failed; see result.json')
        finally:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
if __name__=='__main__':main()
