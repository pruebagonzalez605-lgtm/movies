import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCleanStreamsFromHtml, handleRequest } from '../src/index.js';

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
