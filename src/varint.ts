/**
 * Shared unsigned varint readers used by LevelDB, Snappy, and protobuf parsing.
 * Returns [value, bytesConsumed]. On incomplete input returns [0, 0].
 */

/**
 * Read a varint, always consuming the full encoding (up to 10 bytes).
 * Values above Number.MAX_SAFE_INTEGER are truncated but the byte cursor
 * still advances — required for protobuf fields like 64-bit timestamps.
 */
export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let factor = 1;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i++];
    if (factor <= Number.MAX_SAFE_INTEGER) {
      result += (b & 0x7f) * factor;
    }
    if ((b & 0x80) === 0) return [result, i - pos];
    factor *= 128;
    if (i - pos >= 10) break; // max length of a 64-bit varint
  }
  return [0, 0];
}

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
