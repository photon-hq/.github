export function longestRun(values: readonly number[]): number {
  let longest = 0;
  let count = 0;
  let previous: number | undefined;
  for (const value of values) {
    count = value === previous ? count + 1 : 1;
    previous = value;
    if (count > longest) longest = count;
  }
  return longest;
}
