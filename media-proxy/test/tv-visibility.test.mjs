import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlsVisibility } from '../../src/scripts/tv/controls-visibility.js';

function fixture() {
  const classes = new Set();
  const doc = { activeElement: null };
  const video = { controls: true, focus() { doc.activeElement = video; } };
  const button = { blur() { doc.activeElement = null; } };
  const slot = { ownerDocument: doc, contains: (el) => el === button || el === video,
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  let callback;
  let blocked = false;
  let player = null;
  const controller = createControlsVisibility({ slot, getVideo: () => video, getPlayer: () => player,
    isBlocked: () => blocked, setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => { callback = null; } });
  return { controller, video, button, doc, elapse: () => callback?.(),
    block: (value) => { blocked = value; }, player: (value) => { player = value; } };
}

test('idle controls hide, move focus off buttons and return on activity', () => {
  const f = fixture();
  f.doc.activeElement = f.button;
  f.controller.show();
  f.elapse();
  assert.equal(f.controller.isHidden(), true);
  assert.equal(f.doc.activeElement, f.video);
  assert.equal(f.video.controls, false);
  f.controller.show();
  assert.equal(f.controller.isHidden(), false);
  assert.equal(f.video.controls, true);
});

test('open settings and episode panels keep controls visible until closed', () => {
  const f = fixture();
  f.controller.show(); f.block(true); f.elapse();
  assert.equal(f.controller.isHidden(), false);
  assert.equal(f.controller.hide(), false);
  f.block(false); f.elapse();
  assert.equal(f.controller.isHidden(), true);
});

test('Plyr and TV buttons share hide state; Back only consumes a visible layer', () => {
  const f = fixture(); const toggles = [];
  f.player({ toggleControls: (value) => toggles.push(value) });
  f.controller.show();
  assert.equal(f.controller.hide(), true);
  assert.equal(f.controller.hide(), false);
  assert.deepEqual(toggles, [true, false]);
  f.controller.show(); f.controller.destroy(); f.elapse();
  assert.equal(f.controller.isHidden(), false);
});
