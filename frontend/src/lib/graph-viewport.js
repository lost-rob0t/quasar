export function clampRenderedPosition(position, width, height, padding = 36) {
  const safeWidth = Math.max(width, padding * 2);
  const safeHeight = Math.max(height, padding * 2);
  return {
    x: Math.min(Math.max(position.x, padding), safeWidth - padding),
    y: Math.min(Math.max(position.y, padding), safeHeight - padding)
  };
}
