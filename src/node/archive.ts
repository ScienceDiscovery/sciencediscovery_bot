import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { Counters, exchange, withBody } from '../core/archive.js';
import { jsonBytes, object, string, type Archive, type Doc, type Reply } from '../core/types.js';

const missing = (err: unknown): boolean => object(err).code === 'ENOENT';
export class FileArchive implements Archive {
  readonly eventsPath: string;
  private readonly counters: Counters;
  private constructor(readonly directory: string, window: number) {
    this.eventsPath = resolve(directory, 'events.jsonl'); this.counters = new Counters(window);
  }
  static async open(directory: string, window = 2000): Promise<FileArchive> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new FileArchive(await realpath(directory), window);
    try {
      await stat(store.eventsPath);
      const lines = createInterface({ input: createReadStream(store.eventsPath), crlfDelay: Infinity });
      for await (const line of lines) { const record = store.parse(Buffer.from(line.trim())); if (record) store.counters.count(record); }
    } catch (error) { if (!missing(error)) throw error; }
    return store;
  }
  private parse(line: Uint8Array): Doc | null {
    if (!line.length) return null;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const record = parsed as Doc;
      record.record_id ||= 'legacy-' + createHash('sha256').update(line).digest('hex');
      return record;
    } catch { return null; }
  }
  seen(provider: string, delivery: string): boolean { return this.counters.seen(provider, delivery); }
  async save(reply: Reply, headers: Headers, body: Uint8Array, request: Doc = {}): Promise<void> {
    const { record, detail } = exchange(reply, headers, body, request);
    await this.write(string(record.payload_file), body);
    await this.write(string(record.detail_file), jsonBytes(detail));
    const index = await open(this.eventsPath, 'a', 0o600);
    try { await index.chmod(0o600); await index.writeFile(Buffer.concat([jsonBytes(record), Buffer.from('\n')])); await index.sync(); }
    finally { await index.close(); }
    reply.record = record; this.counters.count(record);
  }
  private async write(name: string, bytes: Uint8Array): Promise<void> {
    const path = resolve(this.directory, name);
    const parent = resolve(path, '..');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // Commit directory entries too, before publishing the index entry.
    const dir = await open(parent, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  private async *reverse(): AsyncGenerator<Doc> {
    let file;
    try { file = await open(this.eventsPath, 'r'); } catch (error) { if (missing(error)) return; throw error; }
    try {
      let position = (await file.stat()).size, pending: Buffer = Buffer.alloc(0);
      while (position) {
        const size = Math.min(position, 65536); position -= size;
        const chunk = Buffer.alloc(size); await file.read(chunk, 0, size, position);
        const combined = Buffer.concat([chunk, pending]);
        let end = combined.length;
        for (let i = combined.length - 1; i >= 0; i--) if (combined[i] === 10) {
          const record = this.parse(combined.subarray(i + 1, end)); if (record) yield record;
          end = i;
        }
        pending = combined.subarray(0, end);
      }
      const record = this.parse(pending); if (record) yield record;
    } finally { await file.close(); }
  }
  async recent(limit = 50, offset = 0, filters: Doc = {}): Promise<Doc[]> {
    const wanted = Object.entries(filters).filter(([, value]) => value !== '' && value !== null && value !== undefined), result: Doc[] = [];
    for await (const record of this.reverse()) {
      if (!wanted.every(([key, value]) => String(record[key]) === String(value))) continue;
      if (offset) { offset--; continue; }
      result.push(record); if (result.length >= limit) break;
    }
    return result;
  }
  async find(identifier: string): Promise<Doc | null> {
    return (await this.recent(1, 0, { record_id: identifier }))[0] || (await this.recent(1, 0, { delivery_id: identifier }))[0] || null;
  }
  private async read(name: unknown): Promise<Uint8Array | null> {
    if (typeof name !== 'string' || !name) return null;
    try {
      const path = await realpath(resolve(this.directory, name)), rel = relative(this.directory, path);
      if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || !(await stat(path)).isFile()) return null;
      return await readFile(path);
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async payload(record: Doc): Promise<Uint8Array | null> { return this.read(record.payload_file); }
  async detail(identifier: string): Promise<Doc | null> {
    const record = await this.find(identifier); if (!record) return null;
    const raw = await this.read(record.detail_file);
    return withBody(record, raw ? JSON.parse(new TextDecoder().decode(raw)) as Doc : null, await this.payload(record));
  }
  status(): Doc { return { ...this.counters.status(), events_file: this.eventsPath }; }
}
