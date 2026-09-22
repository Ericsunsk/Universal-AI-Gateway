// 为网关接入 Qwen 网页版（live 验证通道）。
// 用法：
//   MASTER_KEY=<网关MASTER_KEY> API_KEY=<客户端key> GATEWAY_URL=<网关地址> \
//     QWEN_TOKEN_FILE=/tmp/qwen-verify-token node scripts/wire-qwenweb.mjs
// 说明：经 /admin/api/config 读写，redacted 密钥服务端回填；token 只从文件读，不打印不落盘。
import fs from "node:fs";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/$/, "");
const MASTER_KEY = process.env.MASTER_KEY || "";
const TOKEN_FILE = process.env.QWEN_TOKEN_FILE || "";
if (!MASTER_KEY || !TOKEN_FILE) {
  console.error("missing MASTER_KEY or QWEN_TOKEN_FILE env");
  process.exit(1);
}
const qwenToken = fs.readFileSync(TOKEN_FILE, "utf8").trim();
if (qwenToken.length < 50) {
  console.error("token file looks invalid");
  process.exit(1);
}

const headers = { "Authorization": `Bearer ${MASTER_KEY}`, "Content-Type": "application/json" };
const getRes = await fetch(`${GATEWAY_URL}/admin/api/config`, { headers });
if (!getRes.ok) {
  console.error("GET config failed:", getRes.status);
  process.exit(1);
}
const config = await getRes.json();
const providers = Array.isArray(config.providers) ? config.providers : [];
let qw = providers.find(p => p && p.id === "qwenweb");
if (!qw) {
  qw = { id: "qwenweb", name: "Qwen Web (chat.qwen.ai)", type: "qwenweb", enabled: true, config: {} };
  providers.push(qw);
}
qw.enabled = true;
qw.type = "qwenweb";
qw.config = { ...(qw.config || {}), baseUrl: "https://chat.qwen.ai", token: qwenToken };
config.providers = providers;
config.routes = {
  ...(config.routes || {}),
  "qwen3.7-plus-test": [
    { provider: "qwenweb", model: "qwen3.7-plus" }
  ]
};

const postRes = await fetch(`${GATEWAY_URL}/admin/api/config`, { method: "POST", headers, body: JSON.stringify(config) });
console.log("POST config:", postRes.status, (await postRes.text()).slice(0, 200));
if (!postRes.ok) process.exit(1);
const listKey = process.env.API_KEY || MASTER_KEY;
const models = await (await fetch(`${GATEWAY_URL}/v1/models`, {
  headers: { "Authorization": `Bearer ${listKey}` }
})).json().catch(() => ({}));
const ids = Array.isArray(models.data) ? models.data.map(m => m.id) : [];
console.log("has qwen3.7-plus-test:", ids.includes("qwen3.7-plus-test"));
