// 为网关接入 CodeBuddy 国际站账号（workbuddy-intl + 已验证 serve 的 routes）。
// 用法：
//   MASTER_KEY=<网关MASTER_KEY> GATEWAY_URL=https://vercel.ericsun.pp.ua \
//     INTL_AUTH_FILE="$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info" \
//     node scripts/wire-intl-provider.mjs
// 说明：
// - 经 /admin/api/config 读写，redacted 密钥由服务端 mergeSecrets 自动回填，不会抹掉现网凭据。
// - 账号来源为本机 CLI 登录态文件；脚本只读所需三个字段，不打印、不落盘。
// - 已验证 serve 的 intl 模型才配 routes：glm-5.2、deepseek-v4.1-flash（各带 opencode 兜底）。
import fs from "node:fs";

const GATEWAY_URL = (process.env.GATEWAY_URL || "http://localhost:8787").replace(/\/$/, "");
const MASTER_KEY = process.env.MASTER_KEY || "";
const AUTH_FILE = process.env.INTL_AUTH_FILE ||
  (process.env.HOME + "/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info");

if (!MASTER_KEY) {
  console.error("missing MASTER_KEY env");
  process.exit(1);
}

const authDoc = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
const account = {
  id: "intl-1",
  name: "intl primary",
  enabled: true,
  userId: authDoc.account.uid,
  accessToken: authDoc.auth.accessToken,
  refreshToken: authDoc.auth.refreshToken
};
if (!account.userId || !account.accessToken || !account.refreshToken) {
  console.error("intl auth file lacks userId/accessToken/refreshToken");
  process.exit(1);
}

const headers = {
  "Authorization": `Bearer ${MASTER_KEY}`,
  "Content-Type": "application/json"
};

const getRes = await fetch(`${GATEWAY_URL}/admin/api/config`, { headers });
if (!getRes.ok) {
  console.error("GET config failed:", getRes.status, (await getRes.text()).slice(0, 200));
  process.exit(1);
}
const config = await getRes.json();

const providers = Array.isArray(config.providers) ? config.providers : [];
let intl = providers.find(p => p && p.id === "workbuddy-intl");
if (!intl) {
  intl = { id: "workbuddy-intl", name: "WorkBuddy Intl (codebuddy.ai)", type: "workbuddy", enabled: true, config: { region: "intl", accounts: [] } };
  providers.push(intl);
}
intl.enabled = true;
intl.type = "workbuddy";
intl.config = { ...(intl.config || {}), region: "intl" };
const accounts = Array.isArray(intl.config.accounts) ? intl.config.accounts : [];
const existing = accounts.find(a => a && a.id === "intl-1");
if (existing) {
  Object.assign(existing, account);
} else {
  accounts.push({ ...account });
}
intl.config.accounts = accounts;
config.providers = providers;

const INTL_ROUTES = {
  "glm-5.2-intl": [
    { provider: "workbuddy-intl", model: "glm-5.2" },
    { provider: "opencode", model: "mimo-v2.5-free" }
  ],
  "deepseek-v4.1-flash-intl": [
    { provider: "workbuddy-intl", model: "deepseek-v4.1-flash" },
    { provider: "opencode", model: "mimo-v2.5-free" }
  ]
};
config.routes = { ...(config.routes || {}), ...INTL_ROUTES };

const postRes = await fetch(`${GATEWAY_URL}/admin/api/config`, {
  method: "POST",
  headers,
  body: JSON.stringify(config)
});
const postBody = await postRes.text();
console.log("POST config:", postRes.status, postBody.slice(0, 300));
if (!postRes.ok) process.exit(1);

// 验证：模型列表应包含两条 intl 路由（客户端 key 优先，master 兜底）
const listKey = process.env.API_KEY || MASTER_KEY;
const modelsRes = await fetch(`${GATEWAY_URL}/v1/models`, {
  headers: { "Authorization": `Bearer ${listKey}` }
});
const models = await modelsRes.json().catch(() => ({}));
const ids = Array.isArray(models.data) ? models.data.map(m => m.id) : [];
console.log("has glm-5.2-intl:", ids.includes("glm-5.2-intl"),
  "| has deepseek-v4.1-flash-intl:", ids.includes("deepseek-v4.1-flash-intl"));
