export function foldSpectrum(stripes) {
  const sums = new Map();
  for (const stripe of stripes) {
    const label = stripe.color.trim().toLowerCase();
    const amount = Number.parseFloat(stripe.ink);
    if (!Number.isFinite(amount)) continue;
    const prior = sums.get(label) ?? 0;
    sums.set(label, Math.max(0, prior + amount));
  }
  return Array.from(sums).sort((left, right) => right[1] - left[1]);
}
