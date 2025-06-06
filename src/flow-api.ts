export function readRequest<Methods extends string>(): FlowCall<Methods> {
  try {
    return JSON.parse(Deno.args[0]);
  } catch(_err) {
    const err = _err as Error;
    throw new Error(`Error parsing JSON-RPC payload from Flow Launcher:\n` +
      `Args: ${JSON.stringify(Deno.args)}\n` +
      `Parsing error:\n` +
      `${err.message}`);
  }
}

export function writeResponse(response: FlowResponse) {
  console.log(JSON.stringify(response));
}

export interface FlowCall<Methods extends string> {
  method: 'query' | Methods;
  parameters: string[];
}

export interface FlowResponse {
  result: Result<string>[];
}
export interface Result<Methods extends string> {
  Title: string;
  Subtitle: string;
  JsonRPCAction: JsonRPCAction<Methods>;
  IcoPath: string;
  TitleHighlightData?: number[];
  TitleToolTip?: string;
  SubTitleToolTip?: string;
  /** Must be int */
  Score?: number;
  RecordKey?: string;
}
export interface JsonRPCAction<Methods extends string> {
  method: Methods;
  parameters: string[];
}
