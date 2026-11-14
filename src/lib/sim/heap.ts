// Stable binary min-heap; insertion order resolves otherwise equal event keys.
export class EventHeap<T extends { atMs: number; priority: number; sequence: number }> {
  private items: T[] = [];
  private before(a: T, b: T): boolean {
    return a.atMs < b.atMs || (a.atMs === b.atMs && (a.priority < b.priority || (a.priority === b.priority && a.sequence < b.sequence)));
  }
  push(item: T): void {
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]]; i = parent;
    }
  }
  pop(): T | undefined {
    const root = this.items[0]; const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      let i = 0;
      while (true) {
        let next = i; const left = i * 2 + 1; const right = left + 1;
        if (left < this.items.length && this.before(this.items[left], this.items[next])) next = left;
        if (right < this.items.length && this.before(this.items[right], this.items[next])) next = right;
        if (next === i) break;
        [this.items[i], this.items[next]] = [this.items[next], this.items[i]]; i = next;
      }
    }
    return root;
  }
}
