import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EXTERNAL_AD_NOTICE, externalEmbedUrl } from '../../src/scripts/services/external-playback.js';

const source = readFileSync(new URL('../../src/scripts/player-page.js', import.meta.url), 'utf8');
function functionSource(name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf(nextMarker, start));
}

test('external links accept HTTPS embeds and reject unsafe URLs and poster/media resources', () => {
  assert.equal(externalEmbedUrl('https://moviedays.top/film'), 'https://moviedays.top/film');
  assert.equal(externalEmbedUrl('https://new-provider.example/embed/episode'), 'https://new-provider.example/embed/episode');
  for (const url of ['javascript:alert(1)', 'http://example.com/embed', 'https://user:pass@example.com/embed',
    'https://example.com/poster.jpg', 'https://example.com/video.mp4', 'not a URL']) assert.equal(externalEmbedUrl(url), null);
  assert.match(EXTERNAL_AD_NOTICE, /no a Colevana/);
  assert.match(EXTERNAL_AD_NOTICE, /bloqueador de anuncios/);
});

test('listing preserves unrecognized external providers and MovieDays shortlinks', () => {
  const context = vm.createContext({ URL, externalEmbedUrl, EXTERNAL_PROVIDERS: [],
    MOVIEDAYS_GENERIC_PROVIDER: { name: 'MovieDays' }, playerConsole() {} });
  vm.runInContext(functionSource('mapMovieDaysEmbedToCandidate', 'function buildMovieDaysFallbackUrl'), context);
  vm.runInContext(functionSource('collectExternalCandidates', '// Monta un candidato'), context);
  const result = context.collectExternalCandidates([
    { url: 'https://moviedays.top/film' }, { embed_url: 'https://new-provider.example/episode' },
    { url: 'https://new-provider.example/episode' }, { url: 'https://example.com/poster.png' },
  ]);
  assert.deepEqual(Array.from(result, item => item.url), ['https://moviedays.top/film', 'https://new-provider.example/episode']);
  assert.equal(result[0].iframeEligible, true);
});

for (const kind of ['movie', 'episode']) {
  test(`${kind}: opens an external provider automatically after direct resolution fails`, async () => {
    const calls = [];
    const container = { style: {} };
    const context = vm.createContext({
      state: {}, dom: { status: { style: {} } }, document: { getElementById: () => container },
      window: { setTimeout() {} }, setTimeout() {}, playerConsole() {},
      showExternalLoadingOverlay() {}, hideExternalLoadingOverlay() {},
      getExternalEmbedInfo: async () => ({ kind, tmdbId: 123, season: 1, episode: 1 }),
      removeExternalRetryLink() {}, removeAudioTrackSelector() {},
      fetchExternalCandidates: async () => ({ directStreams: [], embedCandidates: [
        { url: 'https://moviedays.top/film', provider: { name: 'MovieDays' }, iframeEligible: true },
      ] }),
      resolveEmbedStream: async () => null, fetchMovieDaysCandidates: async () => [],
      mountExternalCandidate: async (_, candidate) => { calls.push(candidate.url); return true; },
      bindExternalPlaybackTracking() {}, offerSavedProgress() {},
      showAdblockHint: () => calls.push('notice'), hideAdblockHint() {},
      showExternalRetryLink: (label) => calls.push(label),
      showUnavailablePlayerMessage: () => { throw new Error('Should open the external player'); },
    });
    vm.runInContext('async ' + functionSource('tryHlsWishFallback', '// ==================== EPISODE GRID'), context);
    assert.equal(await context.tryHlsWishFallback(), true);
    assert.deepEqual(calls, ['https://moviedays.top/film', 'notice', '¿No reproduce? Probar otro proveedor']);
    assert.equal(context.state.externalFallbackInProgress, false);
  });
}
