/** Test-only storage. Production must supply a durable Archive implementation. */
import { Counters, exchange, withBody } from '../../src/core/archive.js';
import { string, type Archive, type Doc, type Reply } from '../../src/core/types.js';
export class MemoryArchive implements Archive {
  private counters = new Counters(2000);
  private records: Doc[] = [];
  private bodies = new Map<string, Uint8Array>();
  private details = new Map<string, Doc>();
  seen(provider: string, delivery: string): boolean { return this.counters.seen(provider, delivery); }
  async save(reply: Reply, headers: Headers, body: Uint8Array, request?: Doc): Promise<void> {
    const { record, detail } = exchange(reply, headers, body, request);
    this.bodies.set(string(record.record_id), body.slice()); this.details.set(string(record.record_id), detail); this.records.push(record); reply.record = record; this.counters.count(record);
  }
  async recent(limit: number, offset = 0, filters: Doc = {}): Promise<Doc[]> {
    return [...this.records].reverse().filter(r => Object.entries(filters).every(([key, value]) => value === '' || value === null || String(r[key]) === String(value))).slice(offset, offset + limit);
  }
  async find(identifier: string): Promise<Doc | null> { return (await this.recent(1, 0, { record_id: identifier }))[0] || (await this.recent(1, 0, { delivery_id: identifier }))[0] || null; }
  async payload(record: Doc): Promise<Uint8Array | null> { return this.bodies.get(string(record.record_id)) || null; }
  async detail(identifier: string): Promise<Doc | null> { const record = await this.find(identifier); return record ? withBody(record, this.details.get(string(record.record_id)) || null, await this.payload(record)) : null; }
  status(): Doc { return this.counters.status(); }
}
