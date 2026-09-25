import http from "node:http";
import handler from "./api/index.js";
import { log } from "./src/logging/logger.js";

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";

const server = http.createServer((req, res) => {
  handler(req, res);
});

server.listen(port, host, () => {
  log.info("Server running", { url: `http://${host}:${port}` });
});

process.on("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down gracefully");
  server.close(() => {
    process.exit(0);
  });
});
