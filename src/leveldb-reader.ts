/**
 * Minimal pure-TypeScript LevelDB reader for Edge Workspaces v2.
 * Reads .ldb (SSTable) and .log (Write-Ahead Log) files from a LevelDB directory.
 *
 * Format references:
 * - https://github.com/google/leveldb/blob/master/doc/table_format.md
 * - https://github.com/google/leveldb/blob/master/doc/log_format.md
 * - Ported from https://github.com/cclgroupltd/ccl_chromium_reader
 *
 * Yields `[key, value]` for live entries and `[key, null]` for deletion tombstones
 * so callers can clear superseded keys when replaying newer SST/WAL writes.
 */

import { join } from "jsr:@std/path";
import { readVarint32, readVarintNum } from "./varint.ts";

/** Live value, or `null` for a deletion tombstone. */
export type LevelDbValue = Uint8Array | null;

// ---------------------------------------------------------------------------
// Snappy decompressor (pure TypeScript, no dependencies)
// Reference: https://github.com/google/snappy/blob/main/format_description.txt
// ---------------------------------------------------------------------------

function snappyUncompress(src: Uint8Array): Uint8Array {
  let srcPos = 0;

  const [uncompressedLen, lenBytes] = readVarint32(src, 0);
  if (lenBytes === 0) throw new Error("Snappy: missing length varint");
  srcPos = lenBytes;
  if (uncompressedLen > 64 * 1024 * 1024) throw new Error("Snappy: unreasonably large output");

  const dst = new Uint8Array(uncompressedLen);
  let dstPos = 0;

  while (srcPos < src.length) {
    const tag = src[srcPos++];
    const type = tag & 0x3;

    if (type === 0) {
      // Literal element
      const bits = (tag >> 2) & 0x3f;
      let len: number;
      if (bits < 60) {
        len = bits + 1;
      } else {
        const extra = bits - 59; // 1–4 extra bytes
        len = 0;
        for (let i = 0; i < extra; i++) len |= src[srcPos++] << (i * 8);
        len += 1;
      }
      dst.set(src.subarray(srcPos, srcPos + len), dstPos);
      srcPos += len;
      dstPos += len;
    } else if (type === 1) {
      // Copy with 1-byte offset (11-bit offset)
      const len = ((tag >> 2) & 0x7) + 4;
      const offset = ((tag & 0xe0) << 3) | src[srcPos++];
      if (offset === 0 || offset > dstPos) throw new Error("Snappy: bad copy offset");
      const from = dstPos - offset;
      for (let i = 0; i < len; i++) dst[dstPos++] = dst[from + i];
    } else if (type === 2) {
      // Copy with 2-byte offset
      const len = ((tag >> 2) & 0x3f) + 1;
      const offset = src[srcPos] | (src[srcPos + 1] << 8);
      srcPos += 2;
      if (offset === 0 || offset > dstPos) throw new Error("Snappy: bad copy offset");
      const from = dstPos - offset;
      for (let i = 0; i < len; i++) dst[dstPos++] = dst[from + i];
    } else {
      // Copy with 4-byte offset
      const len = ((tag >> 2) & 0x3f) + 1;
      const offset = (src[srcPos] | (src[srcPos + 1] << 8) |
        (src[srcPos + 2] << 16) | ((src[srcPos + 3] << 24) >>> 0)) >>> 0;
      srcPos += 4;
      if (offset === 0 || offset > dstPos) throw new Error("Snappy: bad copy offset");
      const from = dstPos - offset;
      for (let i = 0; i < len; i++) dst[dstPos++] = dst[from + i];
    }
  }

  return dst.subarray(0, dstPos);
}

// ---------------------------------------------------------------------------
// LevelDB SSTable (.ldb / .sst) reader
// ---------------------------------------------------------------------------

const FOOTER_SIZE = 48; // 40 bytes handles+padding + 8 bytes magic

// 0xdb4775248b80fb57 in little-endian two uint32 halves
const MAGIC_LO = 0x8b80fb57;
const MAGIC_HI = 0xdb477524;

function decompressBlock(fileData: Uint8Array, offset: number, length: number): Uint8Array {
  const raw = fileData.subarray(offset, offset + length);
  const comprType = fileData[offset + length]; // first trailer byte = compression type
  if (comprType === 0) return raw;
  if (comprType === 1) return snappyUncompress(raw);
  throw new Error(`Unsupported LevelDB compression type: ${comprType}`);
}

/**
 * Iterate key-value entries in a LevelDB data block.
 * Block format: restart-array at tail, key-value records from beginning.
 */
function* iterateDataBlock(
  block: Uint8Array,
): Generator<[key: Uint8Array, value: Uint8Array]> {
  if (block.length < 4) return;

  const restartCount =
    (block[block.length - 4]) |
    (block[block.length - 3] << 8) |
    (block[block.length - 2] << 16) |
    (block[block.length - 1] << 24);

  if (restartCount <= 0 || restartCount > block.length / 4) return;

  const restartArrayOffset = block.length - (restartCount + 1) * 4;
  if (restartArrayOffset < 0) return;

  // The first restart offset (restart[0]) should be 0
  let offset =
    (block[restartArrayOffset]) |
    (block[restartArrayOffset + 1] << 8) |
    (block[restartArrayOffset + 2] << 16) |
    (block[restartArrayOffset + 3] << 24);

  let prevKey = new Uint8Array(0);

  while (offset < restartArrayOffset) {
    const mark = offset;

    const [sharedLen, b1] = readVarint32(block, offset);
    if (b1 === 0) break;
    offset += b1;

    const [nonSharedLen, b2] = readVarint32(block, offset);
    if (b2 === 0) break;
    offset += b2;

    const [valueLen, b3] = readVarint32(block, offset);
    if (b3 === 0) break;
    offset += b3;

    if (sharedLen > prevKey.length) break;
    if (offset + nonSharedLen + valueLen > restartArrayOffset) break;

    const key = new Uint8Array(sharedLen + nonSharedLen);
    key.set(prevKey.subarray(0, sharedLen));
    key.set(block.subarray(offset, offset + nonSharedLen), sharedLen);
    offset += nonSharedLen;
    prevKey = key;

    const value = block.subarray(offset, offset + valueLen);
    offset += valueLen;

    yield [key, value];

    if (offset === mark) break; // guard against infinite loop
  }
}

/**
 * Iterate user key-value pairs from an SSTable file.
 * Internal key format: user_key + 8-byte tag (sequence<<8 | type, LE uint64).
 * type=1 means live value; type=0 means deletion tombstone (yielded as null).
 */
function* readLdbFile(
  fileData: Uint8Array,
): Generator<[key: Uint8Array, value: LevelDbValue]> {
  if (fileData.length < FOOTER_SIZE) return;

  const footerStart = fileData.length - FOOTER_SIZE;

  // Verify magic at bytes 40..47 of footer
  const mlo =
    (fileData[footerStart + 40]) |
    (fileData[footerStart + 41] << 8) |
    (fileData[footerStart + 42] << 16) |
    ((fileData[footerStart + 43] << 24) >>> 0);
  const mhi =
    (fileData[footerStart + 44]) |
    (fileData[footerStart + 45] << 8) |
    (fileData[footerStart + 46] << 16) |
    ((fileData[footerStart + 47] << 24) >>> 0);
  if ((mlo >>> 0) !== MAGIC_LO || (mhi >>> 0) !== MAGIC_HI) return;

  // Skip metaindex handle, read index handle
  let pos = footerStart;
  const [, mc1] = readVarintNum(fileData, pos);
  if (mc1 === 0) return;
  const [, mc2] = readVarintNum(fileData, pos + mc1);
  if (mc2 === 0) return;
  pos += mc1 + mc2;

  const [indexOffset, ic1] = readVarintNum(fileData, pos);
  if (ic1 === 0) return;
  const [indexLength, ic2] = readVarintNum(fileData, pos + ic1);
  if (ic2 === 0) return;

  let indexBlock: Uint8Array;
  try {
    indexBlock = decompressBlock(fileData, indexOffset, indexLength);
  } catch {
    return;
  }

  // Each index block entry: key = largest key in data block, value = BlockHandle
  for (const [, handleBytes] of iterateDataBlock(indexBlock)) {
    const [dataOffset, dc1] = readVarintNum(handleBytes, 0);
    if (dc1 === 0) continue;
    const [dataLength, dc2] = readVarintNum(handleBytes, dc1);
    if (dc2 === 0) continue;

    let dataBlock: Uint8Array;
    try {
      dataBlock = decompressBlock(fileData, dataOffset, dataLength);
    } catch {
      continue;
    }

    for (const [internalKey, value] of iterateDataBlock(dataBlock)) {
      // Internal key = user_key + 8-byte packed(seq, type) LE
      // Lowest byte of packed = value type (1=live, 0=deletion)
      if (internalKey.length < 8) continue;
      const valueType = internalKey[internalKey.length - 8];
      const userKey = internalKey.subarray(0, internalKey.length - 8);

      if (valueType === 1) {
        yield [userKey, value];
      } else if (valueType === 0) {
        yield [userKey, null];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LevelDB Write-Ahead Log (.log) reader
// ---------------------------------------------------------------------------

const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7; // 4 CRC + 2 length + 1 type

const LOG_FULL = 1;
const LOG_FIRST = 2;
const LOG_MIDDLE = 3;
const LOG_LAST = 4;

/** Parse a WriteBatch payload and yield key-value pairs (null = deletion). */
function* parseBatch(
  batch: Uint8Array,
): Generator<[key: Uint8Array, value: LevelDbValue]> {
  if (batch.length < 12) return;

  // Batch header: 8 bytes sequence number + 4 bytes count
  const count =
    (batch[8]) | (batch[9] << 8) | (batch[10] << 16) | (batch[11] << 24);

  let offset = 12;

  for (let i = 0; i < count && offset < batch.length; i++) {
    const valueType = batch[offset++];

    const [keyLen, kb] = readVarint32(batch, offset);
    if (kb === 0) return;
    offset += kb;
    if (offset + keyLen > batch.length) return;

    const key = batch.subarray(offset, offset + keyLen);
    offset += keyLen;

    if (valueType === 1) {
      // Live value
      const [valLen, vb] = readVarint32(batch, offset);
      if (vb === 0) return;
      offset += vb;
      if (offset + valLen > batch.length) return;

      const value = batch.subarray(offset, offset + valLen);
      offset += valLen;
      yield [key, value];
    } else if (valueType === 0) {
      // Deletion tombstone — no value bytes follow
      yield [key, null];
    }
  }
}

/** Iterate key-value pairs from a WAL log file (null value = deletion). */
function* readLogFile(
  fileData: Uint8Array,
): Generator<[key: Uint8Array, value: LevelDbValue]> {
  let filePos = 0;
  let currentRecord: Uint8Array | null = null;

  while (filePos < fileData.length) {
    const blockStart = filePos;
    const blockEnd = Math.min(blockStart + LOG_BLOCK_SIZE, fileData.length);
    let blockPos = blockStart;

    while (blockPos + LOG_HEADER_SIZE <= blockEnd) {
      // Zero-padding at end of block
      if (
        fileData[blockPos] === 0 && fileData[blockPos + 1] === 0 &&
        fileData[blockPos + 2] === 0 && fileData[blockPos + 3] === 0 &&
        fileData[blockPos + 4] === 0 && fileData[blockPos + 5] === 0
      ) break;

      const length = fileData[blockPos + 4] | (fileData[blockPos + 5] << 8);
      const type = fileData[blockPos + 6];
      blockPos += LOG_HEADER_SIZE;

      if (blockPos + length > blockEnd) break;

      const data = fileData.subarray(blockPos, blockPos + length);
      blockPos += length;

      if (type === LOG_FULL) {
        yield* parseBatch(data);
      } else if (type === LOG_FIRST) {
        currentRecord = new Uint8Array(data);
      } else if ((type === LOG_MIDDLE || type === LOG_LAST) && currentRecord !== null) {
        const prev: Uint8Array = currentRecord;
        const next: Uint8Array = new Uint8Array(prev.length + data.length);
        next.set(prev);
        next.set(data, prev.length);
        if (type === LOG_LAST) {
          currentRecord = null;
          yield* parseBatch(next);
        } else {
          currentRecord = next;
        }
      }
    }

    filePos = blockStart + LOG_BLOCK_SIZE;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Iterate key-value pairs from all .ldb and .log files in a LevelDB directory.
 * Files are processed in ascending file-number order (log files last, since
 * they contain the most recent writes). Deletion tombstones are yielded as
 * `[key, null]` so callers can remove superseded entries.
 *
 * Silently skips files that cannot be read or parsed (e.g. locked by Edge).
 */
export function* iterateLevelDb(
  dbPath: string,
): Generator<[key: Uint8Array, value: LevelDbValue]> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dbPath)];
  } catch {
    return;
  }

  const fileNum = (name: string) => parseInt(name, 16) || 0;

  // Sort: .ldb/.sst first (older), then .log (newest writes)
  const ldbFiles = entries
    .filter((e) => e.isFile && /\.(ldb|sst)$/i.test(e.name))
    .sort((a, b) => fileNum(a.name) - fileNum(b.name))
    .map((e) => join(dbPath, e.name));

  const logFiles = entries
    .filter((e) => e.isFile && /\.log$/i.test(e.name))
    .sort((a, b) => fileNum(a.name) - fileNum(b.name))
    .map((e) => join(dbPath, e.name));

  for (const filePath of [...ldbFiles, ...logFiles]) {
    let fileData: Uint8Array;
    try {
      fileData = Deno.readFileSync(filePath);
    } catch {
      continue; // locked or unreadable — skip
    }

    try {
      if (/\.log$/i.test(filePath)) {
        yield* readLogFile(fileData);
      } else {
        yield* readLdbFile(fileData);
      }
    } catch {
      // Corrupt or unrecognised format — skip
    }
  }
}
