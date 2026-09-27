// Geometry helpers for Fusion Move connection reconstruction.
// Kept DOM-free so the critical connection logic can be unit tested.

export const transformPoint = (point, bounds, offset = { x: 0, y: 0 }, rotation = 0) => {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - cx;
  const dy = point.y - cy;
  return {
    x: cx + dx * cos - dy * sin + offset.x,
    y: cy + dx * sin + dy * cos + offset.y,
  };
};

export const connectionCorridorBounds = (a, b, width, canvasWidth, canvasHeight) => {
  const pad = Math.max(8, width / 2);
  const x1 = Math.max(0, Math.min(a.x, b.x) - pad);
  const y1 = Math.max(0, Math.min(a.y, b.y) - pad);
  const x2 = Math.min(canvasWidth, Math.max(a.x, b.x) + pad);
  const y2 = Math.min(canvasHeight, Math.max(a.y, b.y) + pad);
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
};

export const defaultConnectionAnchor = (bounds) => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

export const connectionWidthForBounds = (bounds) =>
  Math.max(14, Math.min(72, Math.min(bounds.width, bounds.height) * 0.42));
