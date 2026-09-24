import http from "node:http";
import handler from "./api/index.js";

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";

const server = http.createServer((req, res) => {
  handler(req, res);
});

server.listen(port, host, () => {
  console.log(`[Universal AI Gateway] Server running at http://${host}:${port}`);
});

process.on("SIGTERM", () => {
  console.log("[Universal AI Gateway] Received SIGTERM, shutting down gracefully...");
  server.close(() => {
    process.exit(0);
  });
});
