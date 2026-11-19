import { existsSync, walkSync } from "@std/fs";
import { join } from "@std/path";
import type { EdgeInstance } from "./edge-instances.ts";
import { iterateLevelDb } from "./leveldb-reader.ts";
import { decodeSyncEntity } from "./protobuf.ts";

// Can parse two forms of workspaces:
// v1: WorkspacesCache JSON file, used by Edge < 146
// v2: LevelDB database storing Protobufs, used by Edge >= 146

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
// Workspace parsing
// ---------------------------------------------------------------------------

export function getWorkspaces(instance: EdgeInstance, profile: string): WorkspaceDetail[] {
  // Attempt to parse v1
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

  // Parse v2
  const syncDbPath = getSyncDataLevelDbPath(instance, profile);
  if (existsSync(join(syncDbPath, "CURRENT"))) {
    return getWorkspacesFromSyncData(syncDbPath);
  }

  return [];
}

function getWorkspacesFromSyncData(syncDbPath: string): WorkspaceDetail[] {
  interface Workspace {
    name: string;
    color: number;
    tabCount: number;
  }
  const workspaces = new Map<string, Workspace>();
  const tabCounts = new Map<string, number>();

  const values: Uint8Array[] = [];
  const keyDecoder = new TextDecoder("utf-8", { fatal: false });
  try {
    for (const [key, value] of iterateLevelDb(syncDbPath)) {
      if (keyDecoder.decode(key).startsWith("edge_workspace-dt-")) values.push(value);
    }
  } catch {
    return [];
  }

  for (const value of values) {
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

// Commented fields were present in v1 JSON but never used by our code.
// The new LevelDB parser doesn't parse meaningful values for them.
// Therefore, rather than generate dummy values only to ignore them,
// we've commented them out of this interface definition.
// Kept for posterity in case we want to parse them from v2 in the future.
export interface WorkspaceDetail {
  // accent: boolean;
  // active: boolean;
  // collaboratorsCount: number;
  color: number;
  // connectionUrl: string;
  count: number;
  // edgeWorkspaceVersion: number;
  id: string;
  // isOwner: boolean;
  // isolated: boolean;
  // menuSubtitle: string;
  name: string;
  // shared: boolean;
  // showDisconnectedUI: boolean;
  // workspaceFluidStatus: number;
}