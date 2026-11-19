export function measure(values: number[]) {
  let total = 0;
  let largest = 0;
  for (const value of values) {
    if (value < 0) continue;
    total += value;
    largest = Math.max(largest, value);
  }
  return { total, largest, average: total / values.length };
}
