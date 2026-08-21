/**
 * Shared unsigned varint readers used by LevelDB, Snappy, and protobuf parsing.
 * Returns [value, bytesConsumed]. On incomplete input returns [0, 0].
 */

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
