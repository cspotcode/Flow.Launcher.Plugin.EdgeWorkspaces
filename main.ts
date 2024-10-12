import open from "open";
import { writeResponse } from "./src/flow-api.ts";

const { method, parameters } = JSON.parse(Deno.args[0]);

if (method === "query") {
  writeResponse({
    result: [{
      Title: "Hello World Typescript",
      Subtitle: "Showing your query parameters: " + parameters +
        ". Click to open Flow's website",
      JsonRPCAction: {
        method: "do_something_for_query",
        parameters: ["https://github.com/Flow-Launcher/Flow.Launcher"],
      },
      IcoPath: "Images\\app.png",
    }],
  });
}

if (method === "do_something_for_query") {
  const url = parameters[0];
  await do_something_for_query(url);
}

function do_something_for_query(url: string) {
  open(url, {
    wait: true,
  });
}
