export function isImageURL(raw,base='https://stefanzhang.com/'){try{return /\.(?:avif|webp|png|jpe?g|gif|svg|ico|apng)$/i.test(new URL(raw,base).pathname);}catch{return false;}}
export function cssURLs(css){
 const urls=[];const decode=s=>s.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,(_,hex,char)=>hex?String.fromCodePoint(parseInt(hex,16)):char);
 for(const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi))urls.push(decode(m[1]??m[2]??m[3]));
 for(const m of css.matchAll(/@import\s+["']([^"']+)["']/gi))urls.push(decode(m[1]));
 for(const m of css.matchAll(/["']((?:https?:)?\/\/[^"']+)["']/gi))if(isImageURL(m[1]))urls.push(decode(m[1]));
 return [...new Set(urls)].filter(url=>url&&!url.startsWith('#'));
}
export function structuredImageURLs(value){
 const out=[];function collect(v){if(typeof v==='string')out.push(v);else if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')for(const key of ['url','contentUrl','thumbnailUrl'])if(v[key])collect(v[key]);}
 function visit(v){if(!v||typeof v!=='object')return;if(v['@type']==='ImageObject'||Array.isArray(v['@type'])&&v['@type'].includes('ImageObject'))collect(v);for(const[k,item]of Object.entries(v)){if(['image','logo','thumbnailUrl','avatar','icon'].includes(k))collect(item);else visit(item);}}visit(value);return out;
}
export function hasLocalImagePolicy(policy){const directive=String(policy||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('img-src '));if(!directive)return false;const values=directive.split(/\s+/).slice(1);return values.includes("'self'")&&values.every(v=>["'self'",'data:'].includes(v));}
