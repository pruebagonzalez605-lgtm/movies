export function createControlsVisibility({ slot, getVideo, getPlayer, isBlocked,
  delay = 4000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  const cancel = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const schedule = () => { cancel(); timer = setTimer(() => {
    timer = null;
    if (isBlocked()) schedule();
    else hide();
  }, delay); };
  const isHidden = () => slot.classList.contains('tv-controls-hidden');
  const hide = () => {
    if (isBlocked() || isHidden()) return false;
    cancel();
    const video = getVideo();
    const active = slot.ownerDocument.activeElement;
    if (active && slot.contains(active) && active !== video) {
      // No dejar foco en un botón invisible ni retener :focus-within de Plyr.
      active.blur();
      if (video) { video.tabIndex = 0; video.focus({ preventScroll: true }); }
    }
    slot.classList.add('tv-controls-hidden');
    getPlayer()?.toggleControls?.(false);
    if (video && !getPlayer()) video.controls = false;
    return true;
  };
  const show = () => {
    slot.classList.remove('tv-controls-hidden');
    getPlayer()?.toggleControls?.(true);
    const video = getVideo();
    if (video && !getPlayer()) video.controls = true;
    schedule();
  };
  return { show, hide, isHidden, destroy: cancel };
}
