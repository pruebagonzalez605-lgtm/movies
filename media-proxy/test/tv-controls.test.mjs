import assert from 'node:assert/strict';
import test from 'node:test';
import { seekVideo, remoteKey } from '../../src/scripts/tv/media-controls.js';

const video = (properties = {}) => ({ currentTime: 50, duration: 100, readyState: 1, ...properties });
const ranges = (...windows) => ({ length: windows.length, start: (i) => windows[i][0], end: (i) => windows[i][1] });

test('remote seek moves forward/backward and clamps to movie boundaries', () => {
  const media = video();
  assert.equal(seekVideo(media, -10), true);
  assert.equal(media.currentTime, 40);
  seekVideo(media, 10);
  assert.equal(media.currentTime, 50);
  seekVideo(media, -1000);
  assert.equal(media.currentTime, 0);
  seekVideo(media, 1000);
  assert.equal(media.currentTime, 100);
});

test('HLS seek works with unknown duration and respects discontinuous seekable windows', () => {
  const media = video({ duration: Infinity, seekable: ranges([30, 60], [80, 120]) });
  assert.equal(seekVideo(media, 10), true);
  assert.equal(media.currentTime, 60);
  seekVideo(media, 15);
  assert.equal(media.currentTime, 80);
  seekVideo(media, 1000);
  assert.equal(media.currentTime, 120);
  seekVideo(media, -1000);
  assert.equal(media.currentTime, 30);
});

test('unloaded and unseekable media are left intact', () => {
  const media = video({ readyState: 0 });
  assert.equal(seekVideo(media, 10), false);
  assert.equal(media.currentTime, 50);
  assert.equal(seekVideo(video({ duration: NaN }), 10), false);
  assert.equal(seekVideo(null, 10), false);
});

test('legacy Smart TV key codes map to navigation, playback and back', () => {
  assert.equal(remoteKey({ key: 'Unidentified', keyCode: 417 }), 'MediaFastForward');
  assert.equal(remoteKey({ keyCode: 412 }), 'MediaRewind');
  assert.equal(remoteKey({ keyCode: 10009 }), 'Escape');
  assert.equal(remoteKey({ keyCode: 461 }), 'Escape');
  assert.equal(remoteKey({ key: 'ArrowLeft', keyCode: 37 }), 'ArrowLeft');
});
