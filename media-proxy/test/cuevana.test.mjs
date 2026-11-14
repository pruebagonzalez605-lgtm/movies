import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { decodeCuevanaServer, parseCuevanaServers, pickCuevanaSlug, cuevanaRequest, discoverCuevana } from '../src/cuevana.js';
import { buildProviderCandidates, mergeProviderCandidates, getProviderSandbox } from '../../src/scripts/services/external-providers.js';

test('decodes XOR tokens and base64 links from cuevana data-server', () => {
  assert.equal(decodeCuevanaServer('https://tungtungsahur.cuevana3w.pro/?token=1CFsGAwJTGQlbWQNf'), 'https://morencius.com/v/io3e2gzlvk0f');
  assert.equal(decodeCuevanaServer('https://tungtungsahur.cuevana3w.pro/?token=3D0NXAENTBRFZCkZD'), 'https://vibuxer.com/e/nwbfsgftt8uz');
  assert.equal(decodeCuevanaServer('https://x.example/?v=' + btoa('https://vidapi.xyz/embed/tv/1/1/1')), 'https://vidapi.xyz/embed/tv/1/1/1');
  for (const bad of ['https://x.example/?v=' + btoa('javascript:alert(1)'), 'https://x.example/?v=' + btoa('http://a.example/'),
    'https://x.example/?token=9abc', 'not a url']) assert.equal(decodeCuevanaServer(bad), null);
});

test('parses servers with their language tab, latino first in page order', () => {
  const html = `<ul><li class="tab-video-item"><div><div class="tab-item-name"> Latino <div>HD</div></div></div><ul>
    <li role="presentation" data-server="https://t.example/?token=1CFsGAwJTGQlbWQNf"><span>Servidor Hyper</span></li></ul></li>
    <li class="tab-video-item"><div><div class="tab-item-name"> Multilenguaje [CC] <div>x</div></div></div><ul>
    <li role="presentation" data-server="https://t.example/?v=${btoa('https://vidlink.pro/tv/1/1/1')}"><span> Servidor Death Star </span></li></ul></li></ul>`;
  assert.deepEqual(parseCuevanaServers(html), [
    { url: 'https://morencius.com/v/io3e2gzlvk0f', name: 'Servidor Hyper', language: 'latino' },
    { url: 'https://vidlink.pro/tv/1/1/1', name: 'Servidor Death Star', language: 'sub' },
  ]);
});

test('only accepts the search result whose poster belongs to the TMDB title', () => {
  const html = `<a href="https://cuevana3w.pro/serie/el-cuerpo-falso" data-instant><figure><img src=https://image.tmdb.org/t/p/w200/otro.jpg class="poster"></figure></a>
    <a href="https://cuevana3w.pro/serie/the-body" data-instant><figure><img src=https://image.tmdb.org/t/p/w200/gmuX.jpg class="poster"></figure></a>`;
  assert.equal(pickCuevanaSlug(html, 'serie', new Set(['gmuX.jpg'])), 'the-body');
  assert.equal(pickCuevanaSlug(html, 'serie', new Set(['nada.jpg'])), null);
  assert.equal(pickCuevanaSlug(html, 'pelicula', new Set(['gmuX.jpg'])), null);
});

test('validates request parameters', () => {
  assert.deepEqual(cuevanaRequest(new URLSearchParams('tmdb=5&type=movie')), { tmdb: 5, type: 'movie' });
  assert.deepEqual(cuevanaRequest(new URLSearchParams('tmdb=5&type=tv&season=1&episode=2')), { tmdb: 5, type: 'tv', season: 1, episode: 2 });
  for (const q of ['tmdb=0&type=movie', 'tmdb=5&type=tv&season=1', 'tmdb=5&type=x', 'tmdb=../1&type=movie']) {
    assert.throws(() => cuevanaRequest(new URLSearchParams(q)));
  }
});

test('discovers the verified episode page and lists latino servers first', async () => {
  const pages = {
    'https://api.themoviedb.org/3/tv/291507?api_key=k&language=es-ES': JSON.stringify({ name: 'El cuerpo', original_name: 'The Body', poster_path: '/gmuX.jpg' }),
    'https://api.themoviedb.org/3/tv/291507/images?api_key=k': JSON.stringify({ posters: [], backdrops: [] }),
    'https://cuevana3w.pro/explorar?s=El%20cuerpo': '<a href="https://cuevana3w.pro/pelicula/el-cuerpo"><img src=https://image.tmdb.org/t/p/w200/gmuX.jpg></a>',
    'https://cuevana3w.pro/explorar?s=The%20Body': '<a href="https://cuevana3w.pro/serie/the-body"><img src=https://image.tmdb.org/t/p/w200/gmuX.jpg></a>',
    'https://cuevana3w.pro/serie/the-body/episodio-1x1': `<li class="tab-video-item"><div class="tab-item-name"> Multilenguaje </div>
      <li data-server="https://t.example/?v=${btoa('https://vidlink.pro/tv/1/1/1')}"><span>Death Star</span></li>
      <li class="tab-video-item"><div class="tab-item-name"> Latino </div>
      <li data-server="https://t.example/?token=1CFsGAwJTGQlbWQNf"><span>Hyper</span></li>`,
  };
  const fetcher = async url => pages[url] ? new Response(pages[url]) : new Response('', { status: 404 });
  const result = await discoverCuevana({ tmdb: 291507, type: 'tv', season: 1, episode: 1 }, { fetcher, apiKey: 'k' });
  assert.equal(result.page, 'https://cuevana3w.pro/serie/the-body/episodio-1x1');
  assert.deepEqual(result.embeds.map(e => e.url), ['https://morencius.com/v/io3e2gzlvk0f', 'https://vidlink.pro/tv/1/1/1']);
});

test('only morencius player routes skip the iframe sandbox', () => {
  assert.equal(getProviderSandbox('https://morencius.com/v/io3e2gzlvk0f'), null);
  for (const url of ['https://morencius.com/v/io3e2gzlvk0f?x=1', 'https://morencius.com/e/io3e2gzlvk0f',
    'https://morencius.com.evil.example/v/io3e2gzlvk0f', 'http://morencius.com/v/io3e2gzlvk0f', 'https://vibuxer.com/e/abc123']) {
    assert.notEqual(getProviderSandbox(url), null, url);
  }
});

test('player puts verified cuevana iframes before every other provider', async () => {
  const source = readFileSync(new URL('../../src/scripts/player-page.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function fetchExternalCandidates(');
  const cuevana = { url: 'https://morencius.com/v/abc123', provider: { name: 'Cuevana · Hyper' }, iframeEligible: true, preferIframe: true };
  const context = vm.createContext({ buildProviderCandidates, mergeProviderCandidates, MEDIA_CONFIG: {},
    fetchCuevanaCandidates: async () => ({ embedCandidates: [cuevana] }),
    fetchCinehaxCandidates: async () => ({ directStreams: [], embedCandidates: [{ url: 'https://tukiplay.com/embed/tv/1/1/1', provider: { name: 'TukiPlay' } }] }),
    buildExternalListingUrl: () => 'https://vimeus.com/e/movie', fetchSourceListing: async () => { throw Error('offline'); },
    fetchMovieDaysCandidates: async () => [], playerConsole() {} });
  vm.runInContext(source.slice(start, source.indexOf('async function tryHlsWishFallback', start)), context);
  const result = await context.fetchExternalCandidates({ kind: 'episode', tmdbId: 1, season: 1, episode: 1 });
  assert.equal(result.embedCandidates[0], cuevana);
  assert.equal(result.embedCandidates[1].url, 'https://tukiplay.com/embed/tv/1/1/1');
});

test('a verified iframe is mounted without trying to extract other providers first', async () => {
  const source = readFileSync(new URL('../../src/scripts/player-page.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function tryHlsWishFallback(');
  const calls = [];
  const context = vm.createContext({
    state: {}, dom: { status: { style: {} } }, document: { getElementById: () => ({ style: {} }) },
    window: { setTimeout() {}, clearTimeout() {} }, setTimeout() {}, playerConsole() {},
    showExternalLoadingOverlay() {}, hideExternalLoadingOverlay() {},
    getExternalEmbedInfo: async () => ({ kind: 'episode', tmdbId: 1, season: 1, episode: 1 }),
    removeExternalRetryLink() {}, removeAudioTrackSelector() {}, hideExternalProviderNotice() {},
    fetchExternalCandidates: async () => ({ directStreams: [], movieDaysSearched: true, embedCandidates: [
      { url: 'https://morencius.com/v/abc123', provider: { name: 'Cuevana' }, iframeEligible: true, resolveClean: false, preferIframe: true },
      { url: 'https://tukiplay.com/embed/tv/1/1/1', provider: { name: 'TukiPlay' }, iframeEligible: true, resolveClean: true },
    ] }),
    resolveEmbedStream: async url => { calls.push('resolve ' + url); return null; },
    mountExternalCandidate: (_, candidate) => { calls.push('iframe ' + candidate.url); return true; },
  });
  vm.runInContext(source.slice(start, source.indexOf('// ==================== EPISODE GRID', start)), context);
  assert.equal(await context.tryHlsWishFallback(), true);
  assert.deepEqual(calls, ['iframe https://morencius.com/v/abc123']);
});
