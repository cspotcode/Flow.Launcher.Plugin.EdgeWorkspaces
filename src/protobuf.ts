/**
 * Decode Edge Workspaces v2 sync entities using generated protobuf types.
 * Schema: proto/edge_workspaces.proto → src/gen/edge_workspaces_pb.ts
 */

import { fromBinary } from "@bufbuild/protobuf";
import { SyncEntitySchema } from "./gen/edge_workspaces_pb.ts";

export function decodeSyncEntity(buf: Uint8Array) {
  return fromBinary(SyncEntitySchema, buf);
}
