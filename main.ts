import { writeResponse } from "./src/flow-api.ts";
import { readRequest, Result } from "./src/flow-api.ts";
import Fuse from "npm:fuse.js";
import { getProfiles, getWorkspaces, type WorkspaceDetail } from "./src/edge-workspaces.ts";
import { discoverEdgeInstances, type EdgeInstance } from "./src/edge-instances.ts";

type Methods = 'open_workspace';

const {method, parameters} = readRequest<Methods>();

interface Workspace {
  edgeInstance: EdgeInstance;
  profile: string;
  workspace: WorkspaceDetail;
}

if (method === "query") {
  const fuzzyName = parameters[0];

  // Read all profiles across all edge instances and profiles.
  const workspaces: Workspace[] = [];
  const edgeInstances = await discoverEdgeInstances();
  for(const edgeInstance of edgeInstances) {
    const edgeProfiles = getProfiles(edgeInstance);
    for(const profile of edgeProfiles) {
      const edgeWorkspaces = getWorkspaces(edgeInstance, profile);
      for(const workspace of edgeWorkspaces) {
        workspaces.push({
          edgeInstance,
          profile,
          workspace
        });
      }
    }
  }

  // Fuzzy matching, or list all profiles if no query
  const fuzzyMatcher = new Fuse(workspaces, {keys: ["profile", "workspace.name"]});
  const matches = fuzzyName ? fuzzyMatcher.search(fuzzyName).map(v => v.item) : workspaces;

  // Send back to Flow Launcher
  const results: Result<Methods>[] = matches.map(w => {
    return {
      Title: `${w.workspace.name}`,
      Subtitle: `Edge workspace in profile ${w.profile}`,
      JsonRPCAction: {
        method: "open_workspace",
        parameters: [
          JSON.stringify(w)
        ]
      },
      IcoPath: "Images\\app.png"
    };
  });

  writeResponse({
    result: results
  });
}

// When user chooses a workspace
if (method === "open_workspace") {
  const workspace = JSON.parse(parameters[0]) as Workspace;

  const command = new Deno.Command(workspace.edgeInstance.ExecutablePath, {
    args: [
      `--profile-directory=${workspace.profile}`,
      `--launch-workspace=${workspace.workspace.id}`
    ],
    stdin: 'null',
    stderr: 'null',
    stdout: 'null'
  });

  const childProcess = command.spawn();
  await childProcess.status;
}
