import http from "node:http";
import { pathToFileURL } from "node:url";
import { handleRelayRequest, relayConfigFromEnv } from "./relay.mjs";

const MAX_NODE_BODY_BYTES = 1024 * 1024;

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_NODE_BODY_BYTES) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(nodeResponse, response) {
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers));
  response.arrayBuffer()
    .then((body) => nodeResponse.end(Buffer.from(body)))
    .catch(() => nodeResponse.end());
}

export function createServer(env = process.env, fetcher = fetch) {
  const config = relayConfigFromEnv(env);
  return http.createServer(async (nodeRequest, nodeResponse) => {
    try {
      const method = nodeRequest.method || "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(nodeRequest);
      const host = nodeRequest.headers.host || "localhost";
      const request = new Request(`https://${host}${nodeRequest.url || "/"}`, {
        method,
        headers: nodeRequest.headers,
        ...(body === undefined ? {} : { body }),
      });
      send(nodeResponse, await handleRelayRequest(request, config, fetcher));
    } catch (error) {
      const status = error?.status === 413 ? 413 : 500;
      send(nodeResponse, new Response(JSON.stringify({
        error: status === 413 ? "Request body is too large" : "Relay request failed",
        code: status === 413 ? "payload_too_large" : "relay_error",
      }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 10000);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(`cue-control-board-relay listening on ${port}\n`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
