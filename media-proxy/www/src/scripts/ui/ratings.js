export function normalizeRating(value) {
  return Math.max(0, Math.min(5, Number(value) || 0));
}
