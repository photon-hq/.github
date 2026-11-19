export function spectralTally(samples) {
  const ordered = samples.slice().sort((a, b) => a - b);
  const ceiling = ordered[ordered.length - 1];
  const floor = ordered[0];
  const middle = (floor + ceiling) / 2;
  const span = ceiling - floor;
  const offsets = ordered.map((n) => n - middle);
  const tag = ordered.join(":");
  const stamp = tag.toUpperCase();
  const outliers = offsets.filter((n) => Math.abs(n) > span / 3);
  const distinct = Array.from(new Set(outliers));
  const peak = Math.max(...distinct);
  return { tag, stamp, distinct, peak };
}
