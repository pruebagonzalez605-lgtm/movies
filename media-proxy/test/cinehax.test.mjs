import assert from 'node:assert/strict';
import test from 'node:test';
import { cinehaxPath, discoverCinehax } from '../src/cinehax.js';
import { handleRequest } from '../src/index.js';

test('resolves the requested movie and exact season/episode, rejecting invalid routes', () => {
  assert.equal(cinehaxPath(new URLSearchParams('tmdb=57214&type=movie')), '/embed/movie/57214');
  assert.equal(cinehaxPath(new URLSearchParams('tmdb=1405&type=tv&season=8&episode=12')), '/embed/tv/1405/8/12');
  for (const query of ['tmdb=0&type=movie', 'tmdb=1405&type=tv', 'tmdb=1405&type=tv&season=-1&episode=1']) {
    assert.throws(() => cinehaxPath(new URLSearchParams(query)));
  }
});

test('uses current public tokens, prefers Spanish and keeps working sources after server failure', async () => {
  const calls = [];
  const langs = { latino: { servers: [{ server: 'Down', link: 'a' }, { server: 'Voe', link: 'b' }] },
    sub: { servers: [{ server: 'English', play: 'https://video.example/embed/english' }] } };
  const fetcher = async (url, options) => {
    calls.push(url);
    if (url.endsWith('/embed/tv/1405/8/12')) return new Response(`var LANGS = ${JSON.stringify(langs)};\nvar TOKEN = {validtime: 'fresh-time', token: 'fresh-token'};`);
    if (url.endsWith('/edge-data')) {
      assert.equal(options.body.get('token'), 'fresh-token');
      if (options.body.get('streaming') === 'a') return new Response('', { status: 503 });
      return Response.json({ codigo: 200, url: 'https://play.cinehax.com/clean-player/embed/test' });
    }
    return new Response('<div data-config="{&quot;src&quot;:&quot;https://cdn.example/movie.m3u8?fresh=1&amp;x=2&quot;}"></div>');
  };
  const result = await discoverCinehax('/embed/tv/1405/8/12', fetcher);
  assert.deepEqual(result.directStreams, ['https://cdn.example/movie.m3u8?fresh=1&x=2']);
  assert.match(result.embeds[0].name, /Español Latino/);
  assert.equal(result.embeds.length, 2);
  assert.equal(calls.length, 4);
});

test('keeps verification embeds without fetching their challenge or exposing page tokens', async () => {
  let calls = 0;
  const result = await discoverCinehax('/embed/movie/57214', async () => {
    calls++;
    return new Response('var LANGS = {"latino":{"servers":[{"server":"Voe","play":"https://voe.sx/e/abc"}]}};');
  });
  assert.equal(calls, 1);
  assert.deepEqual(result.directStreams, []);
  assert.equal(result.embeds[0].url, 'https://voe.sx/e/abc');
  const invalid = await handleRequest(new Request('https://proxy.example/cinehax-fallback?tmdb=abc&type=movie'));
  assert.equal(invalid.status, 400);
});
