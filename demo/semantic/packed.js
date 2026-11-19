export function longestRun(values) {
  let best = 0;
  let count = 0;
  let previous;
  for (const value of values) {
    if (value === previous) {
      count += 1;
    } else {
      previous = value;
      count = 1;
    }
    best = Math.max(count, best);
  }
  return best;
}
