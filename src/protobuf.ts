import { fromBinary } from "@bufbuild/protobuf";
import { SyncEntitySchema } from "./gen/edge_workspaces_pb.ts";

/**
 * Decode Edge Workspaces v2 sync entity using generated protobuf types.
 */
export function decodeSyncEntity(buf: Uint8Array) {
  return fromBinary(SyncEntitySchema, buf);
}
