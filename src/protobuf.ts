/**
 * Minimal protobuf wire decoder (varint + length-delimited fields only).
 * No .proto files or generated code — sufficient for Chromium sync entities.
 */

import { readVarint } from "./varint.ts";

export function parseProto(buf: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const fields = new Map<number, (Uint8Array | number)[]>();
  let pos = 0;

  while (pos < buf.length) {
    // Use readVarint (not readVarint32): EntityData timestamps are 64-bit
    // varints; stopping early would skip workspace/tab nested fields.
    const [tag, tagBytes] = readVarint(buf, pos);
    if (tagBytes === 0) break;
    pos += tagBytes;
    if (pos > buf.length) break;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);

    if (wireType === 0) {
      // Varint (may be a 64-bit timestamp — must fully consume)
      const [value, n] = readVarint(buf, pos);
      if (n === 0) break;
      pos += n;
      fields.get(fieldNumber)!.push(value);
    } else if (wireType === 2) {
      // Length-delimited
      const [len, n] = readVarint(buf, pos);
      if (n === 0) break;
      pos += n;
      if (pos + len > buf.length) break;
      fields.get(fieldNumber)!.push(buf.slice(pos, pos + len));
      pos += len;
    } else if (wireType === 5) {
      // 32-bit — skip
      pos += 4;
    } else if (wireType === 1) {
      // 64-bit — skip
      pos += 8;
    } else {
      // Unknown wire type — stop parsing
      break;
    }
  }

  return fields;
}
