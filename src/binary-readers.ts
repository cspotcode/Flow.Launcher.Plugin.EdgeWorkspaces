// ---
// Shared unsigned varint readers used by LevelDB, Snappy, and protobuf parsing.
// Returns [value, bytesConsumed]. On incomplete input returns [0, 0].
// ---

/** Read a 32-bit unsigned varint (LevelDB lengths / Snappy). */
export function readVarint32(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i++];
    result |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) return [result >>> 0, i - pos];
    if (shift >= 32) break;
  }
  return [0, 0];
}

/**
 * Read a varint whose value fits safely in a JS number (< 2^53).
 * Used for LevelDB file offsets and lengths.
 */
export function readVarintNum(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let factor = 1;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * factor;
    factor *= 128;
    if ((b & 0x80) === 0) return [result, i - pos];
    if (factor > Number.MAX_SAFE_INTEGER) break;
  }
  return [0, 0];
}

// ---
// uint LE readers
// ---

/** Read a fixed-width 32-bit little-endian unsigned integer */
export function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset] |
    (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16) |
    (buf[offset + 3] << 24)
  ) >>> 0;
}

/** Read a fixed-width 16-bit little-endian unsigned integer */
export function readU16LE(buf: Uint8Array, offset: number): number {
  return buf[offset] | (buf[offset + 1] << 8);
}