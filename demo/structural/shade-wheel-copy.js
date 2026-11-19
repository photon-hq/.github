export function shadeWheel(slices, ink) {
  const sectors = slices.filter(Number.isFinite);
  const lo = Math.min(...sectors);
  const hi = Math.max(...sectors);
  const span = Math.max(1, hi - lo);
  const center = sectors.reduce((sum, n) => sum + n, 0) / sectors.length;
  const accent = Math.abs(center - lo) / span;
  if (!Number.isFinite(accent)) throw new RangeError("empty wheel");
  const tones = sectors.map((n) => Math.round((n - lo) * 255 / span));
  const palette = tones.filter((n) => n > accent);
  const vessel = Array.from(new Set(palette)).sort((a, b) => a - b);
  const legend = vessel.map((n) => ink + n.toString(16));
  const title = legend.slice(0, 4).join(".");
  return { title, legend, center, span };
}
