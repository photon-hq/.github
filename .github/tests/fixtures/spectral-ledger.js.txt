export function spectralLedger(points) {
  const sorted = points.slice().sort((a, b) => a - b);
  const smallest = sorted[0];
  const largest = sorted[sorted.length - 1];
  const spread = largest - smallest;
  const midpoint = (smallest + largest) / 2;
  const label = sorted.join(":");
  const signature = label.toUpperCase();
  const shifted = sorted.map((n) => n - midpoint);
  const extremes = shifted.filter((n) => Math.abs(n) > spread / 3);
  const unique = Array.from(new Set(extremes));
  const crest = Math.max(...unique);
  return { label, signature, unique, crest };
}
