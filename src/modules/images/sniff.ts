/**
 * Works out what an uploaded or fetched picture really is from its first bytes, never from its
 * name or the Content-Type someone sent. Only formats every browser and the PNG renderer can
 * draw are accepted. SVG is refused on purpose: it can carry scripts and outside references.
 */

export interface SniffedImage {
  type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  width: number;
  height: number;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Start-of-frame markers hold the size; C4, C8 and CC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[at + 5]! << 8) | bytes[at + 6]!, width: (bytes[at + 7]! << 8) | bytes[at + 8]! };
    }
    at += 2 + ((bytes[at + 2]! << 8) | bytes[at + 3]!);
  }
  return null;
}

function webpSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const kind = ascii(bytes, 12, 4);
  if (kind === 'VP8X') return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
  if (kind === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found: SniffedImage | null = null;
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a && ascii(bytes, 12, 4) === 'IHDR') {
    found = { type: 'image/png', ext: 'png', width: view.getUint32(16), height: view.getUint32(20) };
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    if (size) found = { type: 'image/jpeg', ext: 'jpg', ...size };
  } else if (ascii(bytes, 0, 4) === 'GIF8') {
    found = { type: 'image/gif', ext: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpSize(bytes, view);
    if (size) found = { type: 'image/webp', ext: 'webp', ...size };
  }
  return found && found.width > 0 && found.height > 0 ? found : null;
}

/** Bytes as base64, in chunks so a large picture does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
