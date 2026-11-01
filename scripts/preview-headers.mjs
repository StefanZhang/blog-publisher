const response=await fetch('https://release-preview.stefanzhang-com.pages.dev/',{redirect:'manual',signal:AbortSignal.timeout(20000)});
if(response.status!==200||!response.headers.get('x-robots-tag')?.includes('noindex'))throw Error('Preview must be reachable and noindex');await response.body?.cancel();console.log('Preview: HTTP 200 and noindex');
