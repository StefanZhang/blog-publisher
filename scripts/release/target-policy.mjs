import {validateReleaseConfig} from '../lib/release-config.mjs';

// The deployment host is reviewed configuration, never a CLI allowlist override.
// Older sealed records predate publicationOrigin and describe canonical publication only.
export function verificationTarget(input, recordConfig, {local=false}={}) {
  const legacy = recordConfig && !Object.hasOwn(recordConfig, 'publicationOrigin');
  const config = validateReleaseConfig(legacy ? {...recordConfig, publicationOrigin:recordConfig.canonicalOrigin} : recordConfig);
  const base = new URL(input);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      ![base.origin, base.origin + '/'].includes(input)) throw Error('Use an exact origin without credentials, a path, or an explicit default port');
  if (local) {
    if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw Error('--local only permits loopback');
    return {base, kind:'local', queries:false, health:false};
  }
  if (base.protocol !== 'https:' || base.port) throw Error('Remote verification requires HTTPS on the default port');
  const pages = config.pagesProject + '.pages.dev';
  const prefix = base.hostname.endsWith('.' + pages) ? base.hostname.slice(0, -pages.length - 1) : '';
  if (base.hostname === pages || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
    return {base, kind:'pages', queries:false, health:false};
  }
  if (base.origin !== config.publicationOrigin) throw Error('Verification origin does not match the sealed publication target');
  return {base, kind:'publication', queries:true, health:base.origin === 'https://stefanzhang.cn'};
}

export async function verifyTargetHealth(target, fetcher=fetch) {
  if (!target.health) return;
  const response = await fetcher(new URL('/healthz', target.base), {method:'GET', redirect:'manual', signal:AbortSignal.timeout(15000)});
  if (response.status !== 200) { await response.body?.cancel(); throw Error('CN healthz must return HTTP 200'); }
  const reader=response.body?.getReader();
  if (!reader) throw Error('CN healthz has no body');
  const chunks=[];let count=0;
  for (;;) {
    const {value,done}=await reader.read();if(done)break;
    count+=value.length;if(count>1024){await reader.cancel();throw Error('CN healthz response exceeds 1024 bytes');}
    chunks.push(Buffer.from(value));
  }
  if (!/^ok /.test(Buffer.concat(chunks).toString('utf8'))) throw Error('CN healthz must begin with "ok "');
}
