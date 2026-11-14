import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { buildProviderCandidates, mergeProviderCandidates, TMDB_EMBED_PROVIDERS, getProviderSandbox } from '../../src/scripts/services/external-providers.js';

test('each provider has separate movie and episode routes with the exact requested episode', () => {
  const movies = buildProviderCandidates({ kind: 'movie', tmdbId: 57214 });
  const episodes = buildProviderCandidates({ kind: 'episode', tmdbId: 1405, season: 8, episode: 12 });
  assert.equal(movies.length, TMDB_EMBED_PROVIDERS.length);
  assert.equal(episodes.length, TMDB_EMBED_PROVIDERS.length);
  assert.ok(movies.every(c => c.url.endsWith('/movie/57214') && c.resolveClean === true));
  assert.ok(episodes.every(c => c.url.endsWith('/tv/1405/8/12') && c.iframeEligible));
  for (const info of [{ kind: 'movie', tmdbId: '../movie' }, { kind: 'movie', tmdbId: -1 },
    { kind: 'episode', tmdbId: 1405, season: 1, episode: 0 },
    { kind: 'episode', tmdbId: 1405, season: -1, episode: 1 }]) {
    assert.deepEqual(buildProviderCandidates(info), []);
  }
});

test('merge retains alternate providers and episodes while removing duplicate URLs', () => {
  const all = buildProviderCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(mergeProviderCandidates(all, all, [{ url: 'https://new.example/embed' }]).length, TMDB_EMBED_PROVIDERS.length + 1);
});

const source = readFileSync(new URL('../../src/scripts/player-page.js', import.meta.url), 'utf8');
test('iframe mounting rejects unsafe URLs and omits sandbox only for supported provider player routes', async () => {
  const start = source.indexOf('function mountExternalCandidate(');
  const mountSource = source.slice(start, source.indexOf('function showUnavailablePlayerMessage', start));
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
    'https://voe.sx/e/7b9skbphpmon',
  ];
  for (const url of [...trusted, ...restricted]) {
    const attributes = new Map();
    const iframe = { style: {}, setAttribute: (key, value) => attributes.set(key, value) };
    const context = vm.createContext({
      getProviderSandbox, URL, state: {}, dom: {}, document: { createElement: () => iframe },
      stopExternalTracking() {}, removeAudioTrackSelector() {}, destroyPlayerUi() {},
      restoreMediaSlotOverlays() {}, bindExternalPlaybackTracking() {}, hideExternalProviderNotice() {},
      showExternalRetryLink() {},
    });
    vm.runInContext(mountSource, context);
    const mounted = context.mountExternalCandidate({ style: {}, replaceChildren() {} },
      { url, provider: { name: 'Videasy' }, iframeEligible: true });
    if (url.startsWith('http://') || url.includes('@')) {
      assert.equal(mounted, false, url);
      continue;
    }
    assert.equal(mounted, true, url);
    assert.equal(attributes.has('sandbox'), restricted.includes(url), url);
    if (restricted.includes(url)) assert.equal(attributes.get('sandbox'),
      'allow-scripts allow-same-origin allow-presentation allow-forms');
    assert.equal(attributes.has('allowfullscreen'), true);
  }
  assert.equal(getProviderSandbox('https://vidsrc.to/embed/movie/57214'), null);
  // Videasy ya no es proveedor de confianza (dominio caído): va con sandbox.
  assert.notEqual(getProviderSandbox('https://player.videasy.to/movie/57214'), null);
  assert.notEqual(getProviderSandbox('https://player.videasy.to.evil.example/movie/57214'), null);
  assert.notEqual(getProviderSandbox('invalid URL'), null);
});

function readFunction(name, nextMarker) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf(nextMarker, start));
}

test('episodes use the four TMDB providers in order', () => {
  const episode = { kind: 'episode', tmdbId: 62560, season: 1, episode: 1 };
  const candidates = buildProviderCandidates(episode);
  assert.deepEqual(candidates.map(candidate => candidate.provider.name), ['VidSrc', 'VidSrc SH', 'VidSrc Link']);
  assert.ok(candidates.every(candidate => candidate.resolveClean === true));
});

test('direct HLS plays in the native player first and only falls back to an iframe if it fails', async () => {
  for (const works of [true, false]) {
    const calls = [];
    const episode = { kind: 'episode', tmdbId: 62560, season: 1, episode: 1 };
    const context = vm.createContext({
      state: {}, dom: { status: { style: {} } }, document: { getElementById: () => ({ style: {} }) },
      window: { setTimeout() {}, clearTimeout() {} }, setTimeout() {}, playerConsole() {},
      showExternalLoadingOverlay() {}, hideExternalLoadingOverlay() {},
      getExternalEmbedInfo: async () => episode, removeExternalRetryLink() {}, removeAudioTrackSelector() {},
      fetchExternalCandidates: async () => ({ directStreams: ['https://cdn.example/master.m3u8'],
        movieDaysSearched: false, embedCandidates: buildProviderCandidates(episode) }),
      viaHlsProxy: url => url,
      mountDirectStream: async () => { calls.push('native'); return works; },
      resolveEmbedStream: async () => null,
      mountExternalCandidate: (_, candidate) => { calls.push(candidate.url); return true; },
      fetchMovieDaysCandidates: async () => [],
      hideExternalProviderNotice() {}, showExternalRetryLink() {}, getProviderSandbox,
    });
    vm.runInContext(readFunction('tryHlsWishFallback', '// ==================== EPISODE GRID'), context);
    assert.equal(await context.tryHlsWishFallback(), true);
    assert.deepEqual(calls, works ? ['native'] : ['native', 'https://vidsrc.to/embed/tv/62560/1/1']);
  }
});

test('independent providers remain available when both listing services are down', async () => {
  let requests = 0;
  const context = vm.createContext({
    fetchCuevanaCandidates: async () => ({ embedCandidates: [] }), fetchCinehaxCandidates: async () => ({ directStreams: [], embedCandidates: [] }), buildProviderCandidates, mergeProviderCandidates, MEDIA_CONFIG: { proxyBaseUrl: 'https://proxy.example' },
    buildExternalListingUrl: () => 'https://vimeus.com/e/movie',
    fetchSourceListing: async () => { throw Error('offline'); },
    fetchMovieDaysCandidates: async () => { requests++; return []; }, playerConsole() {},
  });
  vm.runInContext(readFunction('fetchExternalCandidates', 'async function tryHlsWishFallback'), context);
  const result = await context.fetchExternalCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(result.embedCandidates.length, TMDB_EMBED_PROVIDERS.length);
  assert.equal(result.movieDaysSearched, true);
  assert.equal(requests, 1);
});

test('a successful primary listing still offers independent sources', async () => {
  const primary = { provider: { name: 'Vimeos' }, url: 'https://vimeos.net/embed-film' };
  const context = vm.createContext({
    fetchCuevanaCandidates: async () => ({ embedCandidates: [] }), fetchCinehaxCandidates: async () => ({ directStreams: [], embedCandidates: [] }), buildProviderCandidates, mergeProviderCandidates, MEDIA_CONFIG: {},
    buildExternalListingUrl: () => 'https://vimeus.com/e/movie',
    fetchSourceListing: async () => ({ ok: true, text: async () => '<script id="data">{}</script>' }),
    DOMParser: class { parseFromString() { return { querySelector: () => ({ textContent: '{}' }) }; } },
    collectDirectStreams: () => [], collectExternalCandidates: () => [primary],
    fetchMovieDaysCandidates: async () => { throw Error('Primary sources must remain first'); }, playerConsole() {},
  });
  vm.runInContext(readFunction('fetchExternalCandidates', 'async function tryHlsWishFallback'), context);
  const result = await context.fetchExternalCandidates({ kind: 'movie', tmdbId: 57214 });
  assert.equal(result.embedCandidates[0], primary);
  assert.equal(result.embedCandidates.length, TMDB_EMBED_PROVIDERS.length + 1);
  assert.equal(result.movieDaysSearched, false);
});

test('automatic discovery keeps title-specific streams when older listings fail', async () => {
  for (const info of [{ kind: 'movie', tmdbId: 550 }, { kind: 'episode', tmdbId: 1405, season: 8, episode: 12 }]) {
    const stream = `https://cdn.example/${info.tmdbId}/${info.season || 0}/${info.episode || 0}.m3u8`;
    const context = vm.createContext({ buildProviderCandidates, mergeProviderCandidates,
      fetchCuevanaCandidates: async () => ({ embedCandidates: [] }), fetchCinehaxCandidates: async requested => {
        assert.equal(requested, info);
        return { directStreams: [stream], embedCandidates: [{ url: 'https://voe.sx/e/source', provider: { name: 'Cinehax' } }] };
      }, MEDIA_CONFIG: {}, buildExternalListingUrl: () => 'https://vimeus.com/e/movie',
      fetchSourceListing: async () => { throw Error('offline'); },
      fetchMovieDaysCandidates: async () => [], playerConsole() {},
    });
    vm.runInContext(readFunction('fetchExternalCandidates', 'async function tryHlsWishFallback'), context);
    const result = await context.fetchExternalCandidates(info);
    assert.equal(result.directStreams[0], stream);
    assert.equal(result.embedCandidates.length, TMDB_EMBED_PROVIDERS.length + 1);
  }
});

test('playback tries public extraction on every provider before a single iframe fallback', async () => {
  const resolved = [];
  const mounted = [];
  const candidates = buildProviderCandidates({ kind: 'movie', tmdbId: 57214 });
  const context = vm.createContext({
    state: {}, dom: { status: { style: {} } }, document: { getElementById: () => ({ style: {} }) },
    window: { setTimeout() {}, clearTimeout() {} }, setTimeout() {}, playerConsole() {}, showExternalLoadingOverlay() {}, hideExternalLoadingOverlay() {},
    getExternalEmbedInfo: async () => ({ kind: 'movie', tmdbId: 57214 }),
    removeExternalRetryLink() {}, removeAudioTrackSelector() {},
    fetchExternalCandidates: async () => ({ directStreams: [], movieDaysSearched: true, embedCandidates: candidates }),
    fetchMovieDaysCandidates: async () => { throw Error('Must not repeat failed listing'); },
    resolveEmbedStream: async url => { resolved.push(url); return null; },
    mountExternalCandidate: (_, candidate) => { mounted.push(candidate.provider.name); return true; },
    hideExternalProviderNotice() {}, showExternalRetryLink() {}, getProviderSandbox,
    showUnavailablePlayerMessage: () => { throw Error('An iframe should load'); },
  });
  vm.runInContext(readFunction('tryHlsWishFallback', '// ==================== EPISODE GRID'), context);
  assert.equal(await context.tryHlsWishFallback(), true);
  assert.deepEqual(resolved, candidates.map(candidate => candidate.url));
  assert.deepEqual(mounted, ['VidSrc']);
});
