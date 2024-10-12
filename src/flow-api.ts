export function readRequest<Methods extends string>(): FlowCall<Methods> {
  return JSON.parse(Deno.args[0]);
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
}
export interface JsonRPCAction<Methods extends string> {
  method: Methods;
  parameters: string[];
}
