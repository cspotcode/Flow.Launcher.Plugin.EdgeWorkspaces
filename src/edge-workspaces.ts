import { existsSync, walkSync } from "jsr:@std/fs";
import { join } from "jsr:@std/path";
import type { EdgeInstance } from "./edge-instances.ts";
import { iterateLevelDb } from "./leveldb-reader.ts";
import { decodeSyncEntity } from "./protobuf.ts";

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

  // Keep only the most-recent write per key; tombstones (null) clear earlier values
  const latest = new Map<string, Uint8Array>();
  const keyDecoder = new TextDecoder("utf-8", { fatal: false });
  try {
    for (const [key, value] of iterateLevelDb(syncDbPath)) {
      const k = keyDecoder.decode(key);
      if (!k.startsWith("edge_workspace-dt-")) continue;
      if (value === null) latest.delete(k);
      else latest.set(k, value);
    }
  } catch {
    return [];
  }

  for (const [, value] of latest) {
    try {
      const { entity } = decodeSyncEntity(value);
      if (!entity?.id) continue;

      if (entity.workspace) {
        workspaces.set(entity.id, {
          name: entity.workspace.name || entity.id,
          color: entity.workspace.color ?? 0,
          tabCount: 0,
        });
      } else if (entity.tab?.parentWorkspaceId) {
        const parentId = entity.tab.parentWorkspaceId;
        tabCounts.set(parentId, (tabCounts.get(parentId) ?? 0) + 1);
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