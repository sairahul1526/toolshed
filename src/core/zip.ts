/**
 * A tiny ZIP writer: store-only (no compression), no dependency, streams its output.
 * Each file is written with a data descriptor, so its size and CRC-32 are not needed up front and a
 * big table never has to sit in memory. Readers that use the central directory (unzip, Finder,
 * Windows, Python, Node libraries) handle this; files over 4 GiB are refused (no ZIP64).
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Running CRC-32. Start with 0 and pass each result back in for the next chunk. */
export function crc32(data: Uint8Array, previous = 0): number {
  let c = ~previous >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX_SIZE = 0xffffffff;
const encoder = new TextEncoder();

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function bytes(length: number, fill: (v: DataView) => void): Uint8Array {
  const out = new Uint8Array(length);
  fill(new DataView(out.buffer));
  return out;
}

export type ZipSink = (chunk: Uint8Array) => Promise<void> | void;

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;
  private done = false;

  constructor(private readonly sink: ZipSink) {}

  private async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    this.offset += chunk.length;
    if (this.offset > MAX_SIZE) throw new Error('The archive is larger than 4 GiB.');
    await this.sink(chunk);
  }

  /** Add one file. `content` may be a string, bytes, or an async stream of either. */
  async addFile(name: string, content: string | Uint8Array | AsyncIterable<string | Uint8Array>, modified = new Date()): Promise<void> {
    if (this.done) throw new Error('The archive is already finished.');
    const nameBytes = encoder.encode(name);
    const { time, date } = dosDateTime(modified);
    const entry: Entry = { name: nameBytes, crc: 0, size: 0, offset: this.offset, dosTime: time, dosDate: date };

    // Local file header. Flags: bit 3 (sizes follow in a descriptor) and bit 11 (UTF-8 names).
    const local = bytes(30 + nameBytes.length, (v) => {
      v.setUint32(0, 0x04034b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 0x0808, true);
      v.setUint16(8, 0, true);
      v.setUint16(10, time, true);
      v.setUint16(12, date, true);
      v.setUint16(26, nameBytes.length, true);
    });
    local.set(nameBytes, 30);
    await this.write(local);

    const parts: AsyncIterable<string | Uint8Array> =
      typeof content === 'string' || content instanceof Uint8Array ? (async function* () { yield content; })() : content;
    for await (const part of parts) {
      const chunk = typeof part === 'string' ? encoder.encode(part) : part;
      entry.crc = crc32(chunk, entry.crc);
      entry.size += chunk.length;
      if (entry.size > MAX_SIZE) throw new Error(`"${name}" is larger than 4 GiB.`);
      await this.write(chunk);
    }

    await this.write(
      bytes(16, (v) => {
        v.setUint32(0, 0x08074b50, true);
        v.setUint32(4, entry.crc, true);
        v.setUint32(8, entry.size, true);
        v.setUint32(12, entry.size, true);
      }),
    );
    this.entries.push(entry);
  }

  /** Write the central directory. Call once, after the last file. */
  async finish(): Promise<void> {
    if (this.done) return;
    this.done = true;
    const start = this.offset;
    for (const e of this.entries) {
      const header = bytes(46 + e.name.length, (v) => {
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, 20, true);
        v.setUint16(6, 20, true);
        v.setUint16(8, 0x0808, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, e.dosTime, true);
        v.setUint16(14, e.dosDate, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, e.size, true);
        v.setUint32(24, e.size, true);
        v.setUint16(28, e.name.length, true);
        v.setUint32(42, e.offset, true);
      });
      header.set(e.name, 46);
      await this.write(header);
    }
    const size = this.offset - start;
    await this.write(
      bytes(22, (v) => {
        v.setUint32(0, 0x06054b50, true);
        v.setUint16(8, this.entries.length, true);
        v.setUint16(10, this.entries.length, true);
        v.setUint32(12, size, true);
        v.setUint32(16, start, true);
      }),
    );
  }
}

/** Build a whole (small) archive in memory. For tests and tiny exports. */
export async function zipBytes(files: { name: string; content: string | Uint8Array }[], modified?: Date): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const zip = new ZipWriter((c) => void chunks.push(c));
  for (const f of files) await zip.addFile(f.name, f.content, modified);
  await zip.finish();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
