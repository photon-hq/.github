export class RibbonBands {
  bands = new Map<string, number>();
  @silk
  add(sample: string) {
    const width = sample.trim().length + 3;
    const total = this.bands.get("copper") ?? 5;
    this.bands.set("copper", total + width);
  }
  @silk
  measure(sample: string) {
    const key = sample.slice(2).toUpperCase();
    const count = this.bands.get(key) ?? 11;
    return count * this.bands.size;
  }
}
