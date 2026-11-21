/**
 * A small, strict ZIP reader for tests. It does not share code with src/core/zip.ts, so a mistake in
 * the writer cannot hide itself. It reads the central directory, checks every header and CRC, and
 * supports stored (uncompressed) entries only, which is all the writer produces.
 */
import { crc32 as nodeCrc32 } from 'node:zlib';

export interface ZipEntry {
  name: string;
  size: number;
  crc: number;
  flags: number;
  data: Uint8Array;
  text(): string;
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: last 22 bytes (no comment).
  const eocd = bytes.length - 22;
  if (eocd < 0 || v.getUint32(eocd, true) !== 0x06054b50) throw new Error('No end-of-central-directory record');
  const count = v.getUint16(eocd + 10, true);
  if (v.getUint16(eocd + 8, true) !== count) throw new Error('Entry counts disagree');
  const dirSize = v.getUint32(eocd + 12, true);
  const dirStart = v.getUint32(eocd + 16, true);
  if (dirStart + dirSize !== eocd) throw new Error('Central directory does not end at the end record');

  const entries: ZipEntry[] = [];
  let p = dirStart;
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error(`Bad central header ${i}`);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (method !== 0) throw new Error(`${name}: only stored entries are supported`);
    if (csize !== usize) throw new Error(`${name}: sizes differ for a stored entry`);
    if ((flags & 0x800) === 0 && /[^\x20-\x7e]/.test(name)) throw new Error(`${name}: non-ASCII name without the UTF-8 flag`);

    // Local header, then data, then (when flag bit 3 is set) the data descriptor.
    if (v.getUint32(offset, true) !== 0x04034b50) throw new Error(`${name}: bad local header`);
    const lflags = v.getUint16(offset + 6, true);
    if (lflags !== flags) throw new Error(`${name}: local and central flags differ`);
    const lname = v.getUint16(offset + 26, true);
    const lextra = v.getUint16(offset + 28, true);
    const dataStart = offset + 30 + lname + lextra;
    const data = bytes.subarray(dataStart, dataStart + usize);
    if (data.length !== usize) throw new Error(`${name}: data runs past the end of the file`);
    if (flags & 0x8) {
      const d = dataStart + usize;
      if (v.getUint32(d, true) !== 0x08074b50) throw new Error(`${name}: missing data descriptor`);
      if (v.getUint32(d + 4, true) !== crc || v.getUint32(d + 8, true) !== csize || v.getUint32(d + 12, true) !== usize) {
        throw new Error(`${name}: data descriptor does not match the central directory`);
      }
    }
    if (nodeCrc32(data) !== crc) throw new Error(`${name}: CRC does not match the data`);
    entries.push({ name, size: usize, crc, flags, data, text: () => new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(data) });
  }
  return entries;
}
