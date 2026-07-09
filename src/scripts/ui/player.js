export function createPlayerController(player, sourceNode, statusNode) {
  return {
    setSource(src, label = "") {
      sourceNode.dataset.baseSrc = src;
      sourceNode.src = src;
      player.load();
      if (statusNode) {
        statusNode.textContent = label;
      }
    },
  };
}
