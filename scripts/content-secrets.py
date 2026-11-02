"""One-time approved GitHub-to-GitHub sealed-box copy. Never prints secret values."""
import base64,json,os,pathlib
from nacl.public import PublicKey,SealedBox
NAMES=('CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','CLOUDFLARE_LIKES_API_TOKEN')
def encrypt(recipient,values):
    if set(recipient)!={'schema','repository','environment','key_id','key'} or recipient['schema']!=1 or recipient['repository']!='StefanZhang/blog-publisher' or recipient['environment']!='content-auto' or not str(recipient['key_id']).isdigit():raise ValueError('Invalid pinned recipient')
    key=base64.b64decode(recipient['key'],validate=True)
    if len(key)!=32 or set(values)!=set(NAMES) or any(not isinstance(v,str) or not v or len(v)>2000 for v in values.values()):raise ValueError('Invalid key or secret inputs')
    box=SealedBox(PublicKey(key))
    return {'schema':1,'repository':recipient['repository'],'environment':recipient['environment'],'key_id':recipient['key_id'],'values':{name:base64.b64encode(box.encrypt(values[name].encode())).decode() for name in NAMES}}
def main():
    if os.environ.get('GITHUB_REPOSITORY')!='StefanZhang/blog-publisher' or os.environ.get('GITHUB_REF')!='refs/heads/main' or os.environ.get('GITHUB_WORKFLOW_REF')!='StefanZhang/blog-publisher/.github/workflows/bootstrap-content-secrets.yml@refs/heads/main':raise ValueError('Wrong bootstrap context')
    result=encrypt(json.loads(pathlib.Path('content-secret-recipient.json').read_text()),{n:os.environ.get(n,'') for n in NAMES})
    target=pathlib.Path('.work/content-secrets.encrypted.json');target.parent.mkdir(exist_ok=True)
    with target.open('x') as f:json.dump(result,f)
    target.chmod(0o600)
    print('Three values encrypted to the reviewed content-auto public key. No plaintext exported.')
if __name__=='__main__':main()
