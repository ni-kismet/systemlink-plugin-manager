/**
 * Extract payload files from a .nipkg archive.
 *
 * A .nipkg is an ar(1) archive containing:
 *   - debian-binary   (version text)
 *   - control.tar[.gz] (package metadata)
 *   - data.tar[.gz]    (payload files)
 *
 * This module parses the ar container, decompresses the data archive,
 * and returns the extracted payload files.
 */

export interface ExtractedFile {
  path: string;
  blob: Blob;
}

/** Extract all payload files from a .nipkg blob. */
export async function extractNipkg(nipkgBlob: Blob): Promise<ExtractedFile[]> {
  const buffer = await nipkgBlob.arrayBuffer();
  const dataEntry = findDataEntry(buffer);

  let tarBuffer: ArrayBuffer;
  if (dataEntry.name.endsWith('.gz')) {
    tarBuffer = await decompressGzip(dataEntry.data);
  } else {
    tarBuffer = dataEntry.data;
  }

  return parseTar(tarBuffer);
}

/** Find the first file matching a predicate in the extracted nipkg contents. */
export async function extractFirstMatch(
  nipkgBlob: Blob,
  predicate: (path: string) => boolean,
): Promise<Blob> {
  const files = await extractNipkg(nipkgBlob);
  const match = files.find(f => predicate(f.path));
  if (!match) {
    const paths = files.map(f => f.path).join(', ');
    throw new Error(`No matching file found in nipkg. Contents: [${paths}]`);
  }
  return match.blob;
}

// ── ar archive parser ──────────────────────────────────────────

const AR_MAGIC = '!<arch>\n';
const AR_HEADER_SIZE = 60;

function findDataEntry(buffer: ArrayBuffer): { name: string; data: ArrayBuffer } {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.slice(0, 8));
  if (magic !== AR_MAGIC) {
    throw new Error('Not a valid ar/nipkg archive');
  }

  let offset = 8;
  while (offset + AR_HEADER_SIZE <= buffer.byteLength) {
    const name = readAscii(bytes, offset, 16).replace(/\/\s*$/, '').trim();
    const size = parseInt(readAscii(bytes, offset + 48, 10), 10);
    offset += AR_HEADER_SIZE;

    if (name.startsWith('data.tar')) {
      return { name, data: buffer.slice(offset, offset + size) };
    }

    offset += size;
    if (offset % 2 !== 0) offset++; // ar entries are 2-byte aligned
  }

  throw new Error('No data.tar entry found in nipkg archive');
}

// ── gzip decompression ─────────────────────────────────────────

async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(new Uint8Array(compressed));
  writer.close();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result.buffer;
}

// ── tar archive parser ─────────────────────────────────────────

function parseTar(buffer: ArrayBuffer): ExtractedFile[] {
  const files: ExtractedFile[] = [];
  const view = new Uint8Array(buffer);
  let offset = 0;

  while (offset + 512 <= buffer.byteLength) {
    // End-of-archive marker: 512 zero bytes
    let allZero = true;
    for (let i = offset; i < offset + 512; i++) {
      if (view[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const name = readAscii(view, offset, 100);
    const sizeStr = readAscii(view, offset + 124, 12);
    const typeflag = view[offset + 156];
    const prefix = readAscii(view, offset + 345, 155);

    const size = parseInt(sizeStr, 8) || 0;
    const fullPath = prefix ? `${prefix}/${name}` : name;

    offset += 512; // skip past header

    // typeflag 0x30 ('0') or 0x00 ('\0') = regular file
    if ((typeflag === 0x30 || typeflag === 0x00) && size > 0 && name) {
      const fileData = buffer.slice(offset, offset + size);
      files.push({ path: fullPath, blob: new Blob([fileData]) });
    }

    // Data blocks are rounded up to 512-byte boundaries
    offset += Math.ceil(size / 512) * 512;
  }

  return files;
}

// ── helpers ─────────────────────────────────────────────────────

function readAscii(view: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && view[end] !== 0) end++;
  return new TextDecoder().decode(view.slice(offset, end));
}
