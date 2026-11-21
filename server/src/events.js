// Ring buffer for events pushed from the game via the __aiNotify binding.
export class EventLog {
  constructor(capacity = 1000) {
    this.capacity = capacity;
    this.items = [];
    this.seq = 0;
  }

  push(payload) {
    const entry = { seq: ++this.seq, at: Date.now(), payload };
    this.items.push(entry);
    if (this.items.length > this.capacity) this.items.shift();
    return entry;
  }

  since(seq = 0, limit = 100) {
    return this.items.filter(e => e.seq > seq).slice(0, limit);
  }
}
