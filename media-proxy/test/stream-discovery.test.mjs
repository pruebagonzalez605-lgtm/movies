import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCleanStreamsFromHtml, handleRequest, validateEmbedUrl } from '../src/index.js';

test('discovers HTML5, JSON, escaped, percent encoded and base64 media without evaluating scripts', () => {
  const html = String.raw`
    <video src="/film.mp4"></video><source src="//goodstream.one/film.webm">
    <script>{"file":"https:\/\/vimeos.net\/master.m3u8?x=1\u0026y=2"}</script>
    <script>hls: 'https:\x2f\x2fvimeos.net\x2fbackup.m3u8'</script>
    <script>url: 'https%3A%2F%2Fvimeos.net%2Fthird.mp4'</script>
    <script>atob('${btoa('https://vimeos.net/fourth.mp4')}')</script>
  `;
  const streams = extractCleanStreamsFromHtml(html, 'https://goodstream.one/embed-film');
  assert.equal(streams.length, 6);
  assert.equal(streams[0], 'https://vimeos.net/master.m3u8?x=1&y=2');
  for (const expected of ['https://goodstream.one/film.mp4', 'https://goodstream.one/film.webm',
    'https://vimeos.net/backup.m3u8', 'https://vimeos.net/third.mp4', 'https://vimeos.net/fourth.mp4']) {
    assert.ok(streams.includes(expected), expected);
  }
});

test('rejects ad videos, demo streams, credentials and duplicates', () => {
  const html = `<source src="https://vimeos.net/ads/preroll.mp4">
    <source src="https://test-streams.mux.dev/demo.m3u8">
    <source src="https://user:password@vimeos.net/film.mp4">
    <source src="http://vimeos.net/insecure.mp4">
    <source src="https://vimeos.net/film.mp4"><source src="https://vimeos.net/film.mp4">`;
  assert.deepEqual(extractCleanStreamsFromHtml(html), ['https://vimeos.net/film.mp4']);
});

test('reads entity-encoded player configuration while rejecting ads inside it', () => {
  const html = '<div data-config="{&quot;src&quot;:&quot;https://cdn.example/master.m3u8?t=abc&amp;x=2&quot;,&quot;ad&quot;:&quot;https://cdn.example/ads/pre.mp4&quot;}"></div>';
  assert.deepEqual(extractCleanStreamsFromHtml(html), ['https://cdn.example/master.m3u8?t=abc&x=2']);
});

test('public extraction accepts only player routes on the added providers', () => {
  for (const url of ['https://player.videasy.to/movie/550', 'https://vidsrc.to/embed/tv/1405/8/12',
    'https://vidsrc.sh/embed/movie/550', 'https://www.vidsrc.link/embed/movie/550',
    'https://play.cinehax.com/clean-player/embed/abc']) assert.equal(validateEmbedUrl(url).href, url);
  for (const url of ['https://play.cinehax.com/edge-data', 'https://vidsrc.sh/admin',
    'https://player.videasy.to.evil.example/movie/550', 'https://voe.sx/e/abc']) assert.throws(() => validateEmbedUrl(url));
});

test('resolver follows permitted redirects and refuses offsite advertising redirects', async context => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, 'manual');
    if (String(url).includes('videasy')) return new Response(null, { status: 302, headers: { Location: 'https://vidsrc.sh/embed/movie/550' } });
    return new Response('<source src="https://cdn.example/movie.mp4">');
  };
  const request = new Request('https://proxy.example/resolve-stream?url=' + encodeURIComponent('https://player.videasy.to/movie/550'));
  assert.equal((await handleRequest(request)).status, 200);
  assert.equal(calls.length, 2);
  calls.length = 0;
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(null, { status: 302, headers: { Location: 'https://ads.example/advert' } }); };
  assert.equal((await handleRequest(request)).status, 502);
  assert.equal(calls.length, 1);
});

test('resolver follows only allowed nested embeds and returns every clean alternative', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === 'https://goodstream.one/embed-film') {
      return new Response('<iframe src="https://ads.example/ad"></iframe><iframe src="https://vimeos.net/embed-film"></iframe>');
    }
    return new Response('<source src="/master.m3u8"><source src="/film.mp4">');
  };
  const response = await handleRequest(new Request('https://proxy.example/resolve-stream?url=' + encodeURIComponent('https://goodstream.one/embed-film')), {});
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['https://goodstream.one/embed-film', 'https://vimeos.net/embed-film']);
  assert.deepEqual(result.streams, ['https://vimeos.net/master.m3u8', 'https://vimeos.net/film.mp4']);
});
