export function readRequest(): FlowCall {
  return JSON.parse(Deno.args[0]);
}

export function writeResponse(response: FlowResponse) {
  console.log(JSON.stringify(response));
}

export interface FlowCall {
  method: 'query' | string;
  parameters: string[];
}

export interface FlowResponse {
  result: Result[];
}
export interface Result {
  Title: string;
  Subtitle: string;
  JsonRPCAction: JsonRPCAction;
  IcoPath: string;
}
export interface JsonRPCAction {
  method: string;
  parameters: string[];
}
