import { existsSync, walkSync } from "jsr:@std/fs";
import { join } from "jsr:@std/path";
import type { EdgeInstance } from "./edge-instances.ts";
import { iterateLevelDb } from "./leveldb-reader.ts";

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

// ---------------------------------------------------------------------------
// Minimal protobuf helpers (varint + length-delimited fields only)
// ---------------------------------------------------------------------------

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let v = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7;
    if (!(b & 0x80)) break;
  }
  return [v, pos];
}

function parseProto(buf: Uint8Array): Map<number, (Uint8Array | number)[]> {
  const f = new Map<number, (Uint8Array | number)[]>();
  let pos = 0;
  while (pos < buf.length) {
    let tag: number; [tag, pos] = readVarint(buf, pos);
    if (pos > buf.length) break;
    const fn = tag >> 3, wt = tag & 7;
    if (!f.has(fn)) f.set(fn, []);
    if (wt === 0) { let v: number; [v, pos] = readVarint(buf, pos); f.get(fn)!.push(v); }
    else if (wt === 2) { let len: number; [len, pos] = readVarint(buf, pos); f.get(fn)!.push(buf.slice(pos, pos + len)); pos += len; }
    else if (wt === 5) pos += 4;
    else if (wt === 1) pos += 8;
    else break; // unknown wire type — stop parsing
  }
  return f;
}

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

export function getProfiles(edgeInstance: EdgeInstance) {
  const edgeProfiles: string[] = [];
  for (const entry of walkSync(edgeInstance.UserData, { maxDepth: 1, includeDirs: true })) {
    const profileName = entry.name;
    if (/^(Default|Profile \d+)$/.test(profileName)) {
      const hasV1 = existsSync(getWorkspacesCachePath(edgeInstance, profileName));
      const hasV2 = existsSync(getSyncDataLevelDbCurrentFile(edgeInstance, profileName));
      if (hasV1 || hasV2) {
        edgeProfiles.push(profileName);
      }
    }
  }
  return edgeProfiles;
}

// ---------------------------------------------------------------------------
// Workspace reading (v1 JSON or v2 protobuf)
// ---------------------------------------------------------------------------

export function getWorkspaces(instance: EdgeInstance, profile: string): WorkspaceDetail[] {
  // v1: WorkspacesCache (JSON file) — used by Edge < 146
  const cachePath = getWorkspacesCachePath(instance, profile);
  if (existsSync(cachePath)) {
    try {
      const workspacesJson = JSON.parse(Deno.readTextFileSync(cachePath)) as WorkspacesJson;
      if (workspacesJson.workspaces?.length > 0) {
        return workspacesJson.workspaces;
      }
    } catch {
      // fall through to v2
    }
  }

  // v2: Sync Data LevelDB (protobuf) — used by Edge >= 146 after Workspaces v2 migration
  const syncDbPath = getSyncDataLevelDbPath(instance, profile);
  if (existsSync(join(syncDbPath, "CURRENT"))) {
    return getWorkspacesFromSyncData(syncDbPath);
  }

  return [];
}

function getWorkspacesFromSyncData(syncDbPath: string): WorkspaceDetail[] {
  // edge_workspace-dt-<uuid> entries:
  //   outer field 2 = EntityData (length-delimited)
  //     inner field 1 = workspace UUID (string)
  //     inner field 4 = workspace metadata (nested proto, present on workspace containers)
  //       sub-field 1 = workspace name (string)
  //       sub-field 2 = color (varint)
  //     inner field 5 = tab entry (nested proto, repeated, present on tab entities)
  //       sub-field 1 = parent workspace UUID (string)

  const workspaces = new Map<string, { name: string; color: number; tabCount: number }>();
  const tabCounts = new Map<string, number>();

  // Keep only the most-recent write per key (WAL replays in sequence)
  const latest = new Map<string, Uint8Array>();
  try {
    for (const [key, value] of iterateLevelDb(syncDbPath)) {
      const k = TEXT_DECODER.decode(key);
      if (k.startsWith("edge_workspace-dt-")) latest.set(k, value);
    }
  } catch {
    return [];
  }

  for (const [, value] of latest) {
    try {
      const outer = parseProto(value);
      const innerBytes = outer.get(2)?.[0];
      if (!(innerBytes instanceof Uint8Array)) continue;

      const inner = parseProto(innerBytes);
      const idBytes = inner.get(1)?.[0];
      if (!(idBytes instanceof Uint8Array)) continue;
      const id = TEXT_DECODER.decode(idBytes);

      if (inner.has(4)) {
        // Workspace container entity — has metadata (name, color)
        const metaBytes = inner.get(4)![0];
        if (metaBytes instanceof Uint8Array) {
          const sub = parseProto(metaBytes);
          const nameBytes = sub.get(1)?.[0];
          const name = nameBytes instanceof Uint8Array ? TEXT_DECODER.decode(nameBytes) : id;
          const color = (sub.get(2)?.[0] as number) ?? 0;
          workspaces.set(id, { name, color, tabCount: 0 });
        }
      } else if (inner.has(5)) {
        // Tab entity — sub-field 1 is the parent workspace UUID
        const tabBytes = inner.get(5)![0];
        if (tabBytes instanceof Uint8Array) {
          const sub = parseProto(tabBytes);
          const parentBytes = sub.get(1)?.[0];
          if (parentBytes instanceof Uint8Array) {
            const parentId = TEXT_DECODER.decode(parentBytes);
            tabCounts.set(parentId, (tabCounts.get(parentId) ?? 0) + 1);
          }
        }
      }
    } catch {
      // Skip malformed entries
    }
  }

  // Merge tab counts into workspace records
  for (const [wsId, count] of tabCounts) {
    if (workspaces.has(wsId)) workspaces.get(wsId)!.tabCount = count;
  }

  return [...workspaces.entries()].map(([id, ws]) => ({
    id,
    name: ws.name,
    count: ws.tabCount,
    color: ws.color,
    accent: false,
    active: true,
    collaboratorsCount: 0,
    connectionUrl: "",
    edgeWorkspaceVersion: 2,
    isOwner: true,
    isolated: false,
    menuSubtitle: "",
    shared: false,
    showDisconnectedUI: false,
    workspaceFluidStatus: 0,
  }));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getWorkspacesCachePath(instance: EdgeInstance, profile: string) {
  return join(instance.UserData, profile, "Workspaces", "WorkspacesCache");
}

function getSyncDataLevelDbPath(instance: EdgeInstance, profile: string) {
  return join(instance.UserData, profile, "Sync Data", "LevelDB");
}

function getSyncDataLevelDbCurrentFile(instance: EdgeInstance, profile: string) {
  return join(getSyncDataLevelDbPath(instance, profile), "CURRENT");
}

/**
 * In Edge >= 146 (Workspaces v2), the Workspaces directory itself IS the
 * LevelDB database (contains CURRENT, MANIFEST, *.ldb, *.log files directly).
 * There is no "LevelDB" subdirectory — the parent folder is the DB root.
 */
function getLevelDbPath(instance: EdgeInstance, profile: string) {
  return join(instance.UserData, profile, "Workspaces");
}

function isLevelDb(dirPath: string): boolean {
  // A LevelDB database directory always has a "CURRENT" file
  return existsSync(join(dirPath, "CURRENT"));
}
export interface WorkspacesJson {
  edgeWorkspaceCacheVersion: number;
  workspaces: WorkspaceDetail[];
}

export interface WorkspaceDetail {
  accent: boolean;
  active: boolean;
  collaboratorsCount: number;
  color: number;
  connectionUrl: string;
  count: number;
  edgeWorkspaceVersion: number;
  id: string;
  isOwner: boolean;
  isolated: boolean;
  menuSubtitle: string;
  name: string;
  shared: boolean;
  showDisconnectedUI: boolean;
  workspaceFluidStatus: number;
}