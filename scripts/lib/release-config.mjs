// A publication can serve the same canonical identity from a second reviewed origin.
// This file is shared by Astro and CLI checks; no environment or Host overrides.
const keys = ['schema', 'canonicalOrigin', 'publicationOrigin', 'pagesProject', 'productionBranch', 'likesApi', 'artalkServer', 'beaconToken', 'wranglerVersion'];
export function validateReleaseConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).length !== keys.length || keys.some(key => !Object.hasOwn(config, key))) {
    throw Error('Release configuration must contain exactly the reviewed fields');
  }
  if (config.schema !== 1 || config.canonicalOrigin !== 'https://stefanzhang.com' ||
      !['https://stefanzhang.com', 'https://stefanzhang.cn'].includes(config.publicationOrigin) ||
      config.pagesProject !== 'stefanzhang-com' || config.productionBranch !== 'main' ||
      config.wranglerVersion !== '4.45.0') throw Error('Unexpected release target or toolchain; review release policy explicitly');
  for (const value of [config.likesApi, config.artalkServer]) {
    if (value === 'off') continue;
    let url; try { url = new URL(value); } catch { throw Error('Invalid service origin'); }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.origin !== value || /REPLACE|example\./i.test(value)) throw Error('Invalid service origin');
  }
  if (typeof config.beaconToken !== 'string' || !/^(?:[a-f0-9]{32})?$/.test(config.beaconToken)) throw Error('Invalid beacon token');
  return config;
}
