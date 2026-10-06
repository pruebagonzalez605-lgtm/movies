// Compartido por botones, teclado y puente Android. No depende de Plyr.
export function remoteKey(event) {
  const aliases = { Select: 'Enter', Accept: 'Enter', FastForward: 'MediaFastForward',
    Rewind: 'MediaRewind', Play: 'MediaPlay', Pause: 'MediaPause', PlayPause: 'MediaPlayPause' };
  const codes = { 13: 'Enter', 19: 'MediaPlayPause', 27: 'Escape', 37: 'ArrowLeft',
    38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 415: 'MediaPlay',
    413: 'MediaStop', 412: 'MediaRewind', 417: 'MediaFastForward', 461: 'Escape',
    10009: 'Escape', 10252: 'MediaPlayPause' };
  return event.key && event.key !== 'Unidentified' ? aliases[event.key] || event.key : codes[event.keyCode] || '';
}

export function seekVideo(video, delta) {
  if (!video || !Number.isFinite(delta) || video.readyState === 0) return false;
  const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  let target = Math.max(0, current + delta);
  // HLS puede tener duración Infinity/NaN: usar su ventana de búsqueda.
  const ranges = video.seekable;
  if (ranges?.length) {
    const windows = Array.from({ length: ranges.length }, (_, i) => [ranges.start(i), ranges.end(i)]);
    if (!windows.some(([start, end]) => target >= start && target <= end)) {
      const edges = windows.flat();
      target = edges.reduce((best, edge) => Math.abs(edge - target) < Math.abs(best - target) ? edge : best);
    }
  } else if (Number.isFinite(video.duration) && video.duration > 0) {
    target = Math.min(target, video.duration);
  } else {
    return false;
  }
  try { video.currentTime = target; return true; } catch { return false; }
}
