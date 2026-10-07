import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildProviderCandidates, mergeProviderCandidates, TMDB_EMBED_PROVIDERS, getProviderSandbox } from '../../src/scripts/services/external-providers.js';

test('each provider has separate movie and episode routes with the exact requested episode', () => {
  const movies = buildProviderCandidates({ kind: 'movie', tmdbId: 57214 });
  const episodes = buildProviderCandidates({ kind: 'episode', tmdbId: 1405, season: 8, episode: 12 });
  assert.equal(movies.length, 4);
  assert.equal(episodes.length, TMDB_EMBED_PROVIDERS.length);
  assert.ok(movies.every(c => c.url.endsWith('/movie/57214') && c.resolveClean === false));
  assert.ok(episodes.every(c => c.url.endsWith('/tv/1405/8/12') && c.iframeEligible));
  for (const info of [{ kind: 'movie', tmdbId: '../movie' }, { kind: 'movie', tmdbId: -1 },
    { kind: 'episode', tmdbId: 1405, season: 1, episode: 0 },
    { kind: 'episode', tmdbId: 1405, season: -1, episode: 1 }]) {
    assert.deepEqual(buildProviderCandidates(info), []);
  }
});

test('merge retains alternate providers and episodes while removing duplicate URLs', () => {
  const all = buildProviderCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(mergeProviderCandidates(all, all, [{ url: 'https://new.example/embed' }]).length, 5);
});

const source = readFileSync(new URL('../../src/scripts/player-page.js', import.meta.url), 'utf8');
test('iframe mounting omits sandbox only for supported provider origins and player routes', async () => {
  const start = source.indexOf('function mountExternalCandidate(');
  const mountSource = source.slice(start, source.indexOf('const RETRY_LINK_ID', start));
  const trusted = [
    ...buildProviderCandidates({ kind: 'movie', tmdbId: 57214 }),
    ...buildProviderCandidates({ kind: 'episode', tmdbId: 62560, season: 1, episode: 1 }),
  ].map(candidate => candidate.url);
  const restricted = [
    'https://player.videasy.to.evil.example/movie/57214',
    'http://player.videasy.to/movie/57214', 'https://user:pass@player.videasy.to/movie/57214',
    'https://player.videasy.to/unrelated', 'https://vidsrc.sh/sandbox.php',
    'https://vidsrc.to.evil.example/embed/movie/57214', 'https://vidsrc.to/embed/tv/62560/1',
    'https://vidsrc.to/embed/movie/57214/extra',
  ];
  for (const url of [...trusted, ...restricted]) {
    const attributes = new Map();
    const listeners = new Map();
    const iframe = { style: {}, setAttribute: (key, value) => attributes.set(key, value),
      addEventListener: (event, callback) => listeners.set(event, callback),
      removeEventListener: event => listeners.delete(event) };
    const context = vm.createContext({
      getProviderSandbox, state: {}, dom: {}, document: { createElement: () => iframe },
      window: { setTimeout: () => 1, clearTimeout() {} },
      stopExternalTracking() {}, destroyPlayerUi() {}, resetCastButton() {}, resetDownloadButton() {},
      restoreMediaSlotOverlays() {},
    });
    vm.runInContext(mountSource, context);
    const loaded = context.mountExternalCandidate({ classList: { remove() {} }, style: {},
      replaceChildren() { listeners.get('load')(); } }, { url, provider: { name: 'Videasy' } });
    assert.equal(await loaded, true);
    assert.equal(attributes.has('sandbox'), restricted.includes(url), url);
    if (restricted.includes(url)) assert.equal(attributes.get('sandbox'),
      'allow-scripts allow-same-origin allow-presentation allow-forms');
    assert.equal(attributes.has('allowfullscreen'), true);
  }
  assert.equal(getProviderSandbox('https://player.videasy.to/movie/57214'), null);
  assert.notEqual(getProviderSandbox('https://player.videasy.to.evil.example/movie/57214'), null);
  assert.notEqual(getProviderSandbox('invalid URL'), null);
});

function readFunction(name, nextMarker) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf(nextMarker, start));
}

test('independent providers remain available when both listing services are down', async () => {
  let requests = 0;
  const context = vm.createContext({
    buildProviderCandidates, mergeProviderCandidates, MEDIA_CONFIG: { proxyBaseUrl: 'https://proxy.example' },
    buildExternalListingUrl: () => 'https://vimeus.com/e/movie',
    fetchSourceListing: async () => { throw Error('offline'); },
    fetchMovieDaysCandidates: async () => { requests++; return []; }, playerConsole() {},
  });
  vm.runInContext(readFunction('fetchExternalCandidates', 'async function tryHlsWishFallback'), context);
  const result = await context.fetchExternalCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(result.embedCandidates.length, 4);
  assert.equal(result.movieDaysSearched, true);
  assert.equal(requests, 1);
});

test('a successful primary listing still offers independent sources', async () => {
  const primary = { provider: { name: 'Vimeos' }, url: 'https://vimeos.net/embed-film' };
  const context = vm.createContext({
    buildProviderCandidates, mergeProviderCandidates, MEDIA_CONFIG: {},
    buildExternalListingUrl: () => 'https://vimeus.com/e/movie',
    fetchSourceListing: async () => ({ ok: true, text: async () => '<script id="data">{}</script>' }),
    DOMParser: class { parseFromString() { return { querySelector: () => ({ textContent: '{}' }) }; } },
    collectDirectStreams: () => [], collectExternalCandidates: () => [primary],
    fetchMovieDaysCandidates: async () => { throw Error('Primary sources must remain first'); }, playerConsole() {},
  });
  vm.runInContext(readFunction('fetchExternalCandidates', 'async function tryHlsWishFallback'), context);
  const result = await context.fetchExternalCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(result.embedCandidates[0], primary);
  assert.equal(result.embedCandidates.length, 5);
  assert.equal(result.movieDaysSearched, false);
});

test('playback tries the next provider on load failure without unsupported extraction or repeated listings', async () => {
  const calls = [];
  const context = vm.createContext({
    state: {}, dom: { status: { style: {} } }, document: { getElementById: () => ({ style: {} }) },
    window: { setTimeout() {}, clearTimeout() {} }, setTimeout() {}, playerConsole() {}, showExternalLoadingOverlay() {}, hideExternalLoadingOverlay() {},
    getExternalEmbedInfo: async () => ({ kind: 'movie', tmdbId: 57214 }),
    removeExternalRetryLink() {}, removeAudioTrackSelector() {},
    fetchExternalCandidates: async () => ({ directStreams: [], movieDaysSearched: true,
      embedCandidates: buildProviderCandidates({ kind: 'movie', tmdbId: 57214 }) }),
    fetchMovieDaysCandidates: async () => { throw Error('Must not repeat failed listing'); },
    resolveEmbedStream: async () => { throw Error('Iframe-only provider must not use extractor'); },
    mountExternalCandidate: async (_, candidate) => { calls.push(candidate.provider.name); return calls.length === 3; },
    bindExternalPlaybackTracking() {}, offerSavedProgress() {}, showAdblockHint() {}, hideAdblockHint() {},
    showExternalRetryLink() {}, showUnavailablePlayerMessage: () => { throw Error('Third provider should load'); },
  });
  vm.runInContext(readFunction('tryHlsWishFallback', '// ==================== EPISODE GRID'), context);
  assert.equal(await context.tryHlsWishFallback(), true);
  assert.deepEqual(calls, ['Videasy', 'VidSrc', 'VidSrc SH']);
});
