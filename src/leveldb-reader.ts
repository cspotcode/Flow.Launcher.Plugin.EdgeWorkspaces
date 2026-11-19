/**
 * Minimal pure-TypeScript, read-only LevelDB reader for Edge Workspaces v2.
 * Snappy block decompression uses the `snappyjs` dependency.
 *
 * Presents the same view a LevelDB client would see: only the latest live value
 * of each key, in ascending key order. Superseded versions, deletion tombstones,
 * and sequence numbers are resolved internally and never exposed.
 *
 * How it works (mirrors LevelDB's own read path):
 * 1. `CURRENT` names the active MANIFEST. Replaying the MANIFEST's VersionEdit
 *    records yields the set of live table files and the oldest log still needed.
 *    Files on disk not listed there are obsolete and ignored.
 * 2. Each live table (.ldb/.sst) is already sorted by internal key: user key
 *    ascending, then sequence number descending. Live logs (.log) are unsorted
 *    write batches; their entries are collected and sorted the same way (this is
 *    what LevelDB's memtable does on recovery).
 * 3. All sources are k-way merged by internal key, so every version of a key
 *    arrives together, newest first. The first version is kept; if it is a
 *    deletion, the key is skipped. Older versions are discarded.
 *
 * Format references:
 * - https://github.com/google/leveldb/blob/main/doc/impl.md
 * - https://github.com/google/leveldb/blob/main/doc/table_format.md
 * - https://github.com/google/leveldb/blob/main/doc/log_format.md
 * - https://github.com/google/leveldb/blob/main/db/version_edit.cc (MANIFEST records)
 * - https://github.com/google/leveldb/blob/main/db/db_iter.cc (version/deletion resolution)
 * - Originally ported from https://github.com/cclgroupltd/ccl_chromium_reader
 */

import { join } from "@std/path";
// @ts-types="@types/snappyjs"
import { uncompress as snappyUncompress } from "snappyjs";
import { readU16LE, readU32LE, readVarint32, readVarintNum } from "./binary-readers.ts";

/** A live key-value pair: the latest, non-deleted value of a key. */
export type LevelDbEntry = [key: Uint8Array, value: Uint8Array];

/** Internal: one versioned write. `value` is `null` for a deletion tombstone. */
type VersionedEntry = [key: Uint8Array, value: Uint8Array | null, seq: number];

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

  const restartCount = readU32LE(block, block.length - 4);

  if (restartCount <= 0 || restartCount > block.length / 4) return;

  const restartArrayOffset = block.length - (restartCount + 1) * 4;
  if (restartArrayOffset < 0) return;

  // The first restart offset (restart[0]) should be 0
  let offset = readU32LE(block, restartArrayOffset);

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
): Generator<VersionedEntry> {
  if (fileData.length < FOOTER_SIZE) return;

  const footerStart = fileData.length - FOOTER_SIZE;

  // Verify magic at bytes 40..47 of footer
  const mlo = readU32LE(fileData, footerStart + 40);
  const mhi = readU32LE(fileData, footerStart + 44);
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
      // Internal key = user_key + 8-byte packed(seq << 8 | type) LE
      // Lowest byte of packed = value type (1=live, 0=deletion); upper 7 bytes = sequence
      if (internalKey.length < 8) continue;
      const tagOffset = internalKey.length - 8;
      const valueType = internalKey[tagOffset];
      const seq = readU32LE(internalKey, tagOffset + 4) * 0x1000000 +
        (readU32LE(internalKey, tagOffset) >>> 8);
      const userKey = internalKey.subarray(0, tagOffset);

      if (valueType === 1) {
        yield [userKey, value, seq];
      } else if (valueType === 0) {
        yield [userKey, null, seq];
      }
    }
  }
}


// ---------------------------------------------------------------------------
// LevelDB log file reader (.log write-ahead logs and MANIFEST)
// ---------------------------------------------------------------------------

const LOG_BLOCK_SIZE = 32768;
const LOG_HEADER_SIZE = 7; // 4 CRC + 2 length + 1 type

const LOG_FULL = 1;
const LOG_FIRST = 2;
const LOG_MIDDLE = 3;
const LOG_LAST = 4;

/**
 * Iterate logical records from a file in LevelDB log format, reassembling
 * records that were fragmented across blocks. Used for both .log write-ahead
 * logs (records are WriteBatches) and MANIFEST files (records are VersionEdits).
 */
function* readLogRecords(fileData: Uint8Array): Generator<Uint8Array> {
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

      const length = readU16LE(fileData, blockPos + 4);
      const type = fileData[blockPos + 6];
      blockPos += LOG_HEADER_SIZE;

      if (blockPos + length > blockEnd) break;

      const data = fileData.subarray(blockPos, blockPos + length);
      blockPos += length;

      if (type === LOG_FULL) {
        yield data;
      } else if (type === LOG_FIRST) {
        currentRecord = new Uint8Array(data);
      } else if ((type === LOG_MIDDLE || type === LOG_LAST) && currentRecord !== null) {
        const prev: Uint8Array = currentRecord;
        const next: Uint8Array = new Uint8Array(prev.length + data.length);
        next.set(prev);
        next.set(data, prev.length);
        if (type === LOG_LAST) {
          currentRecord = null;
          yield next;
        } else {
          currentRecord = next;
        }
      }
    }

    filePos = blockStart + LOG_BLOCK_SIZE;
  }
}

/** Parse a WriteBatch payload and yield its versioned writes. */
function* parseBatch(batch: Uint8Array): Generator<VersionedEntry> {
  if (batch.length < 12) return;

  // Batch header: 8 bytes sequence number + 4 bytes count.
  // Record i in the batch has sequence number baseSeq + i.
  const baseSeq = readU32LE(batch, 4) * 0x100000000 + readU32LE(batch, 0);
  const count = readU32LE(batch, 8);

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
      yield [key, value, baseSeq + i];
    } else if (valueType === 0) {
      // Deletion tombstone - no value bytes follow
      yield [key, null, baseSeq + i];
    } else {
      return; // Unknown record type; the rest of the batch can't be parsed
    }
  }
}

/**
 * Read all writes from a .log file, sorted by internal key order, like
 * LevelDB's memtable.
 */
function readLogFileSorted(fileData: Uint8Array): VersionedEntry[] {
  const entries: VersionedEntry[] = [];
  for (const record of readLogRecords(fileData)) {
    for (const entry of parseBatch(record)) entries.push(entry);
  }
  return entries.sort(compareInternal);
}

// ---------------------------------------------------------------------------
// MANIFEST reader
// ---------------------------------------------------------------------------

// VersionEdit field tags, from leveldb/db/version_edit.cc
const TAG_COMPARATOR = 1;
const TAG_LOG_NUMBER = 2;
const TAG_NEXT_FILE_NUMBER = 3;
const TAG_LAST_SEQUENCE = 4;
const TAG_COMPACT_POINTER = 5;
const TAG_DELETED_FILE = 6;
const TAG_NEW_FILE = 7;
// 8 was kLargeValueRef, no longer used
const TAG_PREV_LOG_NUMBER = 9;

const BYTEWISE_COMPARATOR = "leveldb.BytewiseComparator";

interface ManifestState {
  comparator: string | undefined;
  /** File numbers of live tables, across all levels */
  liveTables: Set<number>;
  /** Logs numbered >= this are live */
  logNumber: number;
  /** An older log that may also still be live (0 if none) */
  prevLogNumber: number;
}

/** Replay every VersionEdit in a MANIFEST to get the current set of live files. */
function parseManifest(fileData: Uint8Array): ManifestState {
  const state: ManifestState = {
    comparator: undefined,
    liveTables: new Set(),
    logNumber: 0,
    prevLogNumber: 0,
  };

  for (const record of readLogRecords(fileData)) {
    let pos = 0;
    const num = () => {
      const [value, n] = readVarintNum(record, pos);
      if (n === 0) throw new Error("Truncated MANIFEST VersionEdit");
      pos += n;
      return value;
    };
    const slice = () => {
      const len = num();
      if (pos + len > record.length) throw new Error("Truncated MANIFEST VersionEdit");
      const bytes = record.subarray(pos, pos + len);
      pos += len;
      return bytes;
    };

    while (pos < record.length) {
      const tag = num();
      switch (tag) {
        case TAG_COMPARATOR:
          state.comparator = new TextDecoder().decode(slice());
          break;
        case TAG_LOG_NUMBER:
          state.logNumber = num();
          break;
        case TAG_NEXT_FILE_NUMBER:
        case TAG_LAST_SEQUENCE:
          num();
          break;
        case TAG_COMPACT_POINTER:
          num(); // level
          slice(); // internal key
          break;
        case TAG_DELETED_FILE:
          num(); // level
          state.liveTables.delete(num());
          break;
        case TAG_NEW_FILE: {
          num(); // level
          const fileNumber = num();
          num(); // file size
          slice(); // smallest internal key
          slice(); // largest internal key
          state.liveTables.add(fileNumber);
          break;
        }
        case TAG_PREV_LOG_NUMBER:
          state.prevLogNumber = num();
          break;
        default:
          throw new Error(`Unknown MANIFEST VersionEdit tag: ${tag}`);
      }
    }
  }

  return state;
}

// ---------------------------------------------------------------------------
// Internal key ordering and merging
// ---------------------------------------------------------------------------

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** LevelDB internal key order: user key ascending, then sequence number descending. */
function compareInternal(a: VersionedEntry, b: VersionedEntry): number {
  return compareBytes(a[0], b[0]) || b[2] - a[2];
}

/**
 * K-way merge of sources that are each sorted by internal key order.
 * A source that throws (corrupt data) is dropped from the merge.
 */
function* mergeSorted(sources: Iterator<VersionedEntry>[]): Generator<VersionedEntry> {
  const advance = (source: Iterator<VersionedEntry>) => {
    try {
      const next = source.next();
      if (!next.done) return next.value;
    } catch {
      // Corrupt source: drop it
    }
    return undefined;
  };

  const heads: { source: Iterator<VersionedEntry>; entry: VersionedEntry }[] = [];
  for (const source of sources) {
    const entry = advance(source);
    if (entry) heads.push({ source, entry });
  }

  // Sources are few (a handful of tables + logs), so a linear scan is fine
  while (heads.length > 0) {
    let min = 0;
    for (let i = 1; i < heads.length; i++) {
      if (compareInternal(heads[i].entry, heads[min].entry) < 0) min = i;
    }
    const head = heads[min];
    yield head.entry;
    const entry = advance(head.source);
    if (entry) head.entry = entry;
    else heads.splice(min, 1);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** LevelDB names files with zero-padded *decimal* numbers, e.g. 000123.ldb */
function parseFileName(name: string): { number: number; isLog: boolean } | undefined {
  const match = /^(\d+)\.(ldb|sst|log)$/i.exec(name);
  if (!match) return undefined;
  return { number: parseInt(match[1], 10), isLog: match[2].toLowerCase() === "log" };
}

/**
 * Determine which table and log files are live, from CURRENT -> MANIFEST.
 * Falls back to every table and log file on disk if the MANIFEST can't be read.
 * That fallback is usually still correct, since versions are resolved by sequence
 * number, but could resurrect a deleted key from an obsolete, not-yet-removed file.
 */
function getLiveFiles(dbPath: string): { tables: string[]; logs: string[] } {
  const onDisk: { number: number; isLog: boolean; path: string }[] = [];
  for (const entry of Deno.readDirSync(dbPath)) {
    if (!entry.isFile) continue;
    const parsed = parseFileName(entry.name);
    if (parsed) onDisk.push({ ...parsed, path: join(dbPath, entry.name) });
  }

  let manifest: ManifestState | undefined;
  try {
    const manifestName = Deno.readTextFileSync(join(dbPath, "CURRENT")).trim();
    manifest = parseManifest(Deno.readFileSync(join(dbPath, manifestName)));
  } catch {
    manifest = undefined;
  }

  if (manifest?.comparator !== undefined && manifest.comparator !== BYTEWISE_COMPARATOR) {
    throw new Error(`Unsupported LevelDB comparator: ${manifest.comparator}`);
  }

  const isLiveTable = (n: number) => !manifest || manifest.liveTables.has(n);
  const isLiveLog = (n: number) =>
    !manifest || n >= manifest.logNumber || n === manifest.prevLogNumber;

  return {
    tables: onDisk.filter((f) => !f.isLog && isLiveTable(f.number)).map((f) => f.path),
    logs: onDisk.filter((f) => f.isLog && isLiveLog(f.number)).map((f) => f.path),
  };
}

/**
 * Iterate the live contents of a LevelDB database: the latest non-deleted value
 * of each key, in ascending key order.
 *
 * Skips files that cannot be read or parsed (e.g. locked or corrupt).
 * Throws if the directory can't be read or uses an unsupported comparator.
 */
export function* iterateLevelDb(dbPath: string): Generator<LevelDbEntry> {
  const { tables, logs } = getLiveFiles(dbPath);

  const readFile = (path: string) => {
    try {
      return Deno.readFileSync(path);
    } catch {
      return undefined; // locked or unreadable - skip
    }
  };

  const sources: Iterator<VersionedEntry>[] = [];
  for (const path of tables) {
    const data = readFile(path);
    if (data) sources.push(readLdbFile(data));
  }
  for (const path of logs) {
    const data = readFile(path);
    if (!data) continue;
    try {
      sources.push(readLogFileSorted(data).values());
    } catch {
      // Corrupt log - skip
    }
  }

  // Versions of a key arrive together, newest first. Keep only the first;
  // if it is a deletion, the key is gone.
  let prevKey: Uint8Array | undefined;
  for (const [key, value] of mergeSorted(sources)) {
    if (prevKey && compareBytes(key, prevKey) === 0) continue;
    prevKey = key;
    if (value !== null) yield [key, value];
  }
}
