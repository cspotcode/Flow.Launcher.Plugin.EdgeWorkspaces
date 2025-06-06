import { writeResponse } from "./src/flow-api.ts";
import { readRequest, Result } from "./src/flow-api.ts";
import Fuse, { type FuseResultMatch } from "npm:fuse.js";
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
  const fuzzyMatcher = new Fuse(workspaces, {keys: ["workspace.name", "profile"], includeScore: true, includeMatches: true});
  const matches = fuzzyName ? fuzzyMatcher.search(fuzzyName) : workspaces.map(w => ({item: w, score: 0, matches: null}));

  const scoreRange = 100;

  // Send back to Flow Launcher
  const results: Result<Methods>[] = matches.map(m => {
    const w = m.item;
    const result: Result<Methods> = {
      Title: `${w.workspace.name}`,
      TitleHighlightData: m.matches ? getHighlight(m.matches) : undefined,
      TitleToolTip: `Tooltip Profile: ${w.profile}`,
      SubTitleToolTip: `subtitel tooltip: Workspace: Profile ${w.profile}, ${w.workspace.count} tabs`,
      Subtitle: `Workspace: Profile ${w.profile}, ${w.workspace.count} tabs`,
      Score: Math.floor((1 - m.score!) * scoreRange),
      JsonRPCAction: {
        method: "open_workspace",
        parameters: [
          JSON.stringify(w)
        ]
      },
      IcoPath: "Images\\app.png",
      RecordKey: `${w.keys.toString()}` // TODO: Use the record key here
    };
    return result;
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


// Value from Fuse looks like this:
// [
//   { indices: [ [ 2, 3 ] ], value: "Default", key: "profile" },
//   {
//     indices: [ [ 0, 0 ], [ 3, 5 ] ],
//     value: "A: Family",
//     key: "workspace.name"
//   }
// ],
// Desired output:
// [0, 3, 4, 5]
//
// Each indices tuple is a range of characters.  The output should include an int for each character.
// Only lok at "key": "workspace.name", ignore "profile"
function getHighlight(indices: readonly FuseResultMatch[], offset = 0): number[] {
  const highlightedCharacters: number[] = [];
  indices
    .filter(i => i.key === "workspace.name")
    .flatMap(i => i.indices)
    .forEach(i => {
      for(let j = i[0]; j <= i[1]; j++) {
        highlightedCharacters.push(j + offset);
      }
    });
  return highlightedCharacters;
}