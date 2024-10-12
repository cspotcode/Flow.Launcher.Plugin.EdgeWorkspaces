import { existsSync, walkSync } from "jsr:@std/fs";
import { join } from "jsr:@std/path";
import type { EdgeInstance } from "./edge-instances.ts";

const edgeUserData = join(Deno.env.get("LOCALAPPDATA")!, "Microsoft", "Edge", "User Data");

export function getProfiles(edgeInstance: EdgeInstance) {
  const edgeProfiles: string[] = [];
  for (const entry of walkSync(edgeInstance.UserData, { maxDepth: 1, includeDirs: true })) {
    const profileName = entry.name;
    if (/^(Default|Profile \d+)$/.test(profileName)) {
      if (existsSync(getWorkspacesCachePath(edgeInstance, profileName))) {
        edgeProfiles.push(profileName);
      }
    }
  }
  return edgeProfiles;
}
export function getWorkspaces(instance: EdgeInstance, profile: string): WorkspaceDetail[] {
    const p = getWorkspacesCachePath(instance, profile);
    const workspacesJson = JSON.parse(Deno.readTextFileSync(p)) as WorkspacesJson;
    return workspacesJson.workspaces;
}

function getWorkspacesCachePath(instance: EdgeInstance, profile: string) {
  return join(instance.UserData, profile, "Workspaces", "WorkspacesCache");
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