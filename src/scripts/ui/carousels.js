export function clearNode(node) {
  if (node) {
    node.innerHTML = "";
  }
}

export function createPosterCardData(item) {
  return {
    title: item.title || "",
    poster: item.poster || null,
    description: item.description || "",
  };
}
