"""Generate constrained Nginx data from the reviewed delivery manifest, never executable package text."""
import re
from urllib.parse import unquote, urlsplit, parse_qs, quote

CANONICAL = 'https://stefanzhang.com'
PUBLICATION = 'https://stefanzhang.cn'
HEADERS_SHA = '1d9a23042b6420610c190f2d0106a9dea1e8be3dc3c989c0497203f1ed356fbe'
CONTROL = {'_headers', '_redirects', '_worker.js', '_routes.json'}
MANIFEST_PATH = '_delivery/manifest.json'
MAX_MANIFEST = 8 * 1024 * 1024
MAX_TOTAL = 450 * 1024 * 1024
MAX_FILE = 25 * 1024 * 1024
HEX64 = re.compile(r'^[a-f0-9]{64}$')
TOKEN = re.compile(r'(:[A-Za-z]\w*|\*)')

def keys(obj, expected):
    return isinstance(obj, dict) and set(obj) == set(expected)

def safe_file(name):
    if not isinstance(name, str) or not name or len(name) > 4096 or name.startswith('/') or re.search(r'[\\\x00-\x1f\x7f]', name):
        raise ValueError('Unsafe delivery file path')
    if any(not p or p in ('.', '..') or p.startswith('.') for p in name.split('/')) or name in CONTROL or name == MANIFEST_PATH:
        raise ValueError('Private/control delivery file path')
    if re.match(r'^(src|scripts|tests|migration|assets|node_modules)/', name) or re.match(r'^(release|source-files|verified-[^/]+)\.json$', name) or re.search(r'\.(pem|key|sql|sqlite|db|php|sh)$', name, re.I):
        raise ValueError('Private/executable delivery file path')
    return name

def file_route(name):
    safe_file(name)
    if name == 'index.html': return '/'
    if name.endswith('/index.html'): name = name[:-10]
    elif name.endswith('.html'): name = name[:-5]
    return '/' + '/'.join(quote(p, safe="~!*'()") for p in name.split('/'))

def safe_route(value, fragment=False):
    if not isinstance(value, str) or len(value) > 4096 or not value.startswith('/') or value.startswith('//') or '?' in value or '$' in value or (not fragment and '#' in value) or re.search(r'[\\\x00-\x20\x7f]', value):
        raise ValueError('Unsafe route')
    path = value.split('#')[0]
    if re.search(r'%(?![a-fA-F0-9]{2})', value): raise ValueError('Malformed route encoding')
    decoded = unquote(path, errors='strict')
    if re.search(r'[\\\x00-\x1f\x7f]',unquote(value,errors='strict')): raise ValueError('Unsafe decoded fragment')
    if re.search(r'[\\\x00-\x1f\x7f]', decoded) or decoded.startswith('//') or any(p in ('.', '..') for p in decoded.split('/')):
        raise ValueError('Unsafe decoded route')
    return value

def validate_manifest(m):
    if not keys(m, ['schema','canonicalOrigin','publicationOrigin','headersSHA256','files','routing']) or m['schema'] != 1 or m['canonicalOrigin'] != CANONICAL or m['publicationOrigin'] != PUBLICATION or m['headersSHA256'] != HEADERS_SHA:
        raise ValueError('Unreviewed manifest identity/header profile')
    files = m['files']
    if not isinstance(files, dict) or not 1 <= len(files) <= 19995: raise ValueError('File count limit')
    total = 0; routes = set()
    for name, meta in files.items():
        safe_file(name)
        if not keys(meta, ['bytes','sha256']) or type(meta['bytes']) is not int or not 0 <= meta['bytes'] <= MAX_FILE or not isinstance(meta['sha256'], str) or not HEX64.fullmatch(meta['sha256']): raise ValueError('Bad file identity')
        total += meta['bytes']; route = file_route(name)
        if route in routes: raise ValueError('Duplicate file route')
        routes.add(route)
        parts = name.split('/')
        if any('/'.join(parts[:i]) in files for i in range(1,len(parts))): raise ValueError('File/directory collision')
    if total > MAX_TOTAL: raise ValueError('Total byte limit')
    r = m['routing']
    if not keys(r,['redirects','attachments','queries']): raise ValueError('Bad routing schema')
    for field, limit in [('redirects',2100),('attachments',2000),('queries',5000)]:
        if not isinstance(r[field],list) or len(r[field]) > limit: raise ValueError('Routing limit')
    seen=set()
    for rule in r['redirects']:
        if not keys(rule,['source','target','status']) or rule['status'] != 301: raise ValueError('Unsupported redirect')
        source=safe_route(rule['source']); safe_route(rule['target'],True)
        tokens=TOKEN.findall(source)
        if any(t not in [':page',':slug','*'] for t in tokens) or len(tokens)!=len(set(tokens)) or ':' in source.replace(':page','').replace(':slug',''): raise ValueError('Unsupported capture')
        names=[t[1:] if t!='*' else 'splat' for t in tokens]
        if any(t[1:] not in names for t in TOKEN.findall(rule['target'])) or '*' in rule['target'] or ':' in re.sub(r':(?:page|slug|splat)','',rule['target']): raise ValueError('Unbound target capture')
        if source in seen: raise ValueError('Duplicate redirect')
        seen.add(source)
    seen=set()
    for rule in r['attachments']:
        if not keys(rule,['path','target']): raise ValueError('Bad attachment')
        safe_route(rule['path']); safe_route(rule['target'],True)
        if rule['path'].endswith('/') or rule['path'] in seen: raise ValueError('Bad attachment key')
        seen.add(rule['path'])
    seen=set();previous=-1
    for rule in r['queries']:
        if not keys(rule,['parameter','value','target','status']) or rule['parameter'] not in ['p','page_id','attachment_id'] or rule['status']!=301 or not isinstance(rule['value'],str) or not re.fullmatch(r'\d+',rule['value']): raise ValueError('Bad query rule')
        order=['p','page_id','attachment_id'].index(rule['parameter'])
        if order<previous or (rule['parameter'],rule['value']) in seen: raise ValueError('Query order/duplicate')
        previous=order;seen.add((rule['parameter'],rule['value']));safe_route(rule['target'],True)
    return total

def nq(value, variables=False):
    # Nginx quoted tokens still expand variables: only our generated capture names
    # may use that feature. Literal dollar signs are always escaped.
    value=value.replace('\\','\\\\').replace('"','\\"')
    if not variables: value=value.replace('$','\\$')
    return '"'+value+'"'

def encoded_char(char):
    encoded=''.join('%'+''.join('['+c.lower()+c.upper()+']' if c.lower() in 'abcdef' else c for c in f'{b:02X}') for b in char.encode('utf8'))
    return '(?:'+re.escape(char)+'|'+encoded+')'

def attachment_pattern(path):
    # JS decodeURI keeps reserved ASCII escape sequences. Actual source keys
    # contain no reserved escapes; reject those rather than broadening semantics.
    if re.search(r'%(?:2[fF]|3[fFaAbB]|23|26|3[dD]|40|24|2[cCbB])',path): raise ValueError('Unsupported reserved escape in attachment key')
    reserved=";/?:@&=+$,#"
    return '^'+''.join(re.escape(c) if c in reserved else encoded_char(c) for c in path)+'/?$'

def redirect_pattern(source,index):
    names={};parts=[]
    for part in TOKEN.split(source):
        if part=='*' or part.startswith(':'):
            name='splat' if part=='*' else part[1:];var=f'cn_r{index}_{name}';names[name]=var
            parts.append('(?<'+var+'>'+('.*' if part=='*' else '[^/]+')+')')
        else: parts.append(re.escape(part))
    return '^'+''.join(parts)+'$',names

def target_value(target,names):
    parts=re.split(r'(:[A-Za-z]\w*)',target);value=''
    for part in parts:
        if part.startswith(':'): value+='$'+names[part[1:]]
        else: value+=part.replace('$','\\$')
    # No arbitrary input dollar reaches variable expansion.
    return nq(value,variables=True)

def generate_nginx(m,site_root):
    validate_manifest(m)
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',str(site_root)) or '..' in str(site_root).split('/'): raise ValueError('Unsafe fixed site root')
    r=m['routing'];http=['# Generated from validated structured data; do not edit.', 'map $request_uri $cn_request_path {', ' default "";', ' "~^(?<cn_path_capture>[^?]*)" $cn_path_capture;', '}']
    for param in ['p','page_id','attachment_id']:
        kp=''.join(encoded_char(c) for c in param)
        first='^/\\?(?:(?!'+kp+'(?:=|&|$))[^&]*&)*'+kp+'(?:=(?<cn_arg_'+param+'>[^&]*))?(?:&|$)'
        http += ['map $request_uri $cn_raw_'+param+' {',' default "";', ' '+nq('~'+first,variables=True)+' $cn_arg_'+param+';','}', 'map $cn_raw_'+param+' $cn_query_'+param+' {',' default "";']
        for q in r['queries']:
            if q['parameter']==param:http.append(' '+nq('~^'+''.join(encoded_char(c) for c in q['value'])+'$',variables=True)+' '+nq(q['target'])+';')
        http.append('}')
    http += ['map $cn_query_p $cn_query_primary { default $cn_query_p; "" $cn_query_page_id; }','map $cn_query_primary $cn_query_target { default $cn_query_primary; "" $cn_query_attachment_id; }','map $cn_request_path $cn_attachment_target {',' default "";']
    for a in r['attachments']: http.append(' '+nq('~'+attachment_pattern(a['path']),variables=True)+' '+nq(a['target'])+';')
    http += ['}','map $cn_request_path $cn_regular_target {',' default "";']
    for i,rule in enumerate(r['redirects']):
        pattern,names=redirect_pattern(rule['source'],i);http.append(' '+nq('~'+pattern,variables=True)+' '+target_value(rule['target'],names)+';')
    http += ['}','map $cn_attachment_target $cn_path_target { default $cn_attachment_target; "" $cn_regular_target; }','map $cn_query_target $cn_redirect_target { default $cn_query_target; "" $cn_path_target; }','map $uri $cn_cache {',' default "public, max-age=0, must-revalidate";',' ~^/(?:_astro|images/opt)/ "public, max-age=31536000, immutable";',' ~^/og/ "public, max-age=604800";',' /healthz "no-store";',' /rss.xml "public, max-age=1800";',' /feed.json "public, max-age=1800";',' /search-index.json "public, max-age=3600";','}']
    server=['# Root is immutable: existing workers keep old routing and old bytes.', 'root '+nq(str(site_root))+';', 'index index.html;', 'autoindex off;', 'default_type application/octet-stream;', 'types { text/html html; text/css css; application/javascript js; application/json json webmanifest; application/xml xml; text/plain txt; image/png png; image/jpeg jpg jpeg; image/gif gif; image/webp webp; image/avif avif; image/svg+xml svg; image/x-icon ico; application/pdf pdf; video/mp4 mp4; video/webm webm; audio/mpeg mp3; }', 'add_header X-Content-Type-Options nosniff always;', 'add_header Content-Security-Policy "img-src \'self\' data:; object-src \'none\'; base-uri \'self\'" always;', 'add_header Referrer-Policy strict-origin-when-cross-origin always;', 'add_header X-Frame-Options SAMEORIGIN always;', 'add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;', 'add_header Cache-Control $cn_cache always;', '# CN remains indexable; Pages preview noindex is not copied.', 'if ($cn_redirect_target != "") { return 301 $cn_redirect_target; }', 'location = /healthz { alias /var/lib/static-node-monitor/ok; default_type text/plain; }', 'location ~ (^|/)\\. { return 404; }']
    for name in sorted(CONTROL):server.append('location = /'+name+' { return 404; }')
    server+=['location / { try_files $uri $uri/ $uri.html =404; }','error_page 404 /404.html;','location = /404.html { internal; }']
    return '\n'.join(http)+'\n','\n'.join(server)+'\n'

def next_redirect(input_url,routing):
    """Reference model for the supported rules, used by offline fixtures only."""
    u=urlsplit(input_url);p=quote(u.path,safe=";/?:@&=+$,-_.!~*'()%")
    if p=='/':
        args=parse_qs(u.query,keep_blank_values=True)
        for q in routing['queries']:
            if args.get(q['parameter'],[None])[0]==q['value']:return q['target']
    # Current attachment data has no reserved percent escapes (validated above).
    key=unquote(p).rstrip('/')
    for a in routing['attachments']:
        if a['path']==key:return a['target']
    for i,r in enumerate(routing['redirects']):
        pattern,names=redirect_pattern(r['source'],i)
        pattern=re.sub(r'\(\?<([^>]+)>',r'(?P<\1>',pattern)
        match=re.fullmatch(pattern,p)
        if match:return re.sub(r':([A-Za-z]\w*)',lambda n:match.group(names[n[1]]),r['target'])
    return None
