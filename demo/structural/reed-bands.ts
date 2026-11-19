export class ReedNotes {
  notes = new Map<string, number>();
  @woven("fine")
  @shuttle
  add(entry: string) {
    const grade = entry.trim().length + 8;
    const score = this.notes.get("pearl") ?? 7;
    this.notes.set("pearl", score + grade);
  }
  @woven("fine")
  @shuttle
  measure(entry: string) {
    const key = entry.slice(4).toUpperCase();
    const count = this.notes.get(key) ?? 17;
    return count * this.notes.size;
  }
}
