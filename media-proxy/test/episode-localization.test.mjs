import test from 'node:test';
import assert from 'node:assert/strict';
import { tmdbGetSeasonEpisodes } from '../../src/scripts/services/tmdb.js';
import { splitTranslationText } from '../../src/scripts/services/episode-text.js';
import { ensureSeasonEpisodes } from '../../src/scripts/shared/catalog-data.js';

function setup(t, handler) {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const storage = new Map();
  const calls = [];
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    calls.push(parsed);
    return Response.json(await handler(parsed));
  };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; });
  return { storage, calls };
}

test('English-looking populated metadata prefers official Spanish by episode number', async t => {
  const { calls } = setup(t, url => {
    const lang = url.searchParams.get('language');
    const episodes = lang === 'es-MX'
      ? [{ episode_number: 3, name: 'El regreso', overview: 'Regresan a casa.' },
        { episode_number: 1, name: 'El comienzo', overview: 'La aventura comienza.' }]
      : [{ episode_number: 1, name: 'The beginning', overview: 'The adventure begins.' },
        { episode_number: 3, name: 'The return', overview: 'They return home.' }];
    return { episodes };
  });
  const result = await tmdbGetSeasonEpisodes(990001, 1);
  assert.deepEqual(result.map(ep => [ep.episodeNumber, ep.title, ep.description]),
    [[1, 'El comienzo', 'La aventura comienza.'], [3, 'El regreso', 'Regresan a casa.']]);
  assert.ok(calls.some(url => url.searchParams.get('language') === 'en-US'));
  assert.ok(calls.every(url => !url.hostname.includes('mymemory')));
});

test('per-episode Spanish translations can supply both fields and preserve proper names', async t => {
  setup(t, url => url.pathname.endsWith('/translations')
    ? { translations: [{ iso_639_1: 'es', iso_3166_1: 'MX', data: { name: 'Dexter', overview: 'Dexter busca pistas.' } }] }
    : { episodes: [{ episode_number: 4, name: 'Dexter', overview: '' }] });
  const [episode] = await tmdbGetSeasonEpisodes(990002, 1);
  assert.equal(episode.episodeNumber, 4);
  assert.equal(episode.title, 'Dexter');
  assert.equal(episode.description, 'Dexter busca pistas.');
});

test('long English synopses translate in UTF-8-safe segments and simultaneous season loads share requests', async t => {
  const overview = 'The crew searches for clues and returns home. '.repeat(30);
  const { calls } = setup(t, url => {
    if (url.hostname.includes('mymemory')) {
      const source = url.searchParams.get('q');
      assert.ok(new TextEncoder().encode(source).length <= 500);
      return { responseStatus: 200, responseData: { translatedText: source === 'The voyage' ? 'El viaje' : 'La tripulación busca pistas y regresa a casa.' } };
    }
    if (url.pathname.endsWith('/translations')) return { translations: [] };
    return { episodes: [{ episode_number: 1, name: 'The voyage', overview }] };
  });
  const [a, b] = await Promise.all([tmdbGetSeasonEpisodes(990003, 1), tmdbGetSeasonEpisodes(990003, 1)]);
  assert.deepEqual(a, b);
  assert.equal(a[0].title, 'El viaje');
  assert.ok(a[0].description.startsWith('La tripulación'));
  assert.equal(calls.filter(url => url.searchParams.get('language') === 'en-US').length, 1);
  assert.ok(calls.filter(url => url.hostname.includes('mymemory')).length > 2);
  const unicode = '😀é'.repeat(400);
  const chunks = splitTranslationText(unicode);
  assert.equal(chunks.join(''), unicode);
  assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).length <= 500));
});

test('translation quota errors never become episode text or a month-long season cache', async t => {
  const { storage } = setup(t, url => {
    if (url.hostname.includes('mymemory')) return { responseStatus: 429, quotaFinished: true, responseData: { translatedText: 'YOU USED ALL AVAILABLE FREE TRANSLATIONS' } };
    if (url.pathname.endsWith('/translations')) return { translations: [] };
    return { episodes: [{ episode_number: 1, name: 'The chase', overview: 'They follow a clue.' }] };
  });
  const [episode] = await tmdbGetSeasonEpisodes(990004, 1);
  assert.equal(episode.title, 'The chase');
  assert.equal(episode.description, 'They follow a clue.');
  const cached = JSON.parse(storage.get('tmdb_cache_season_v6_990004_1'));
  assert.ok(cached.expiresAt - Date.now() <= 3600000);
});

test('catalog keeps source and episode numbers aligned when TMDB omits an episode', async t => {
  setup(t, url => {
    if (url.pathname.includes('/search/')) return { results: [{ id: 990005 }] };
    const english = url.searchParams.get('language') === 'en-US';
    return { episodes: [
      { episode_number: 1, name: english ? 'The start' : 'El inicio', overview: english ? 'They begin.' : 'Empiezan.', runtime: 42, air_date: '2020-01-01' },
      { episode_number: 3, name: english ? 'The end' : 'El final', overview: english ? 'They finish.' : 'Terminan.' },
    ] };
  });
  const episodes = await ensureSeasonEpisodes({ title: 'Fixture' }, { season: 1, srcs: ['first.mp4', 'second.mp4', 'third.mp4'] });
  assert.deepEqual(episodes.map(ep => [ep.title, ep.src]),
    [['El inicio', 'first.mp4'], ['Episodio 2', 'second.mp4'], ['El final', 'third.mp4']]);
  assert.equal(episodes[0].runtime, 42);
  assert.equal(episodes[0].airDate, '2020-01-01');
});
