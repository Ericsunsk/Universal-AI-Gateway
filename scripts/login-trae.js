#!/usr/bin/env node
/**
 * login-trae.js — Interactive OAuth 2.0 PKCE login helper for ByteDance Trae.
 *
 * Implements RFC 8252 (OAuth 2.0 for Native Apps with Loopback Redirect):
 * 1. Spawns a local HTTP server listening on http://127.0.0.1:54571/authorize.
 * 2. Generates PKCE code_verifier and code_challenge (S256).
 * 3. Constructs the official authorization URL (client_id: ono9krqynydwx5, app_id: 677332).
 * 4. Awaits the browser callback, exchanges authorization code for tokens at grow-normal.traeapi.us/token.
 * 5. Outputs the captured credentials ready for worker-ai-gateway.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ID = "ono9krqynydwx5";
const APP_ID = "677332";
const PORT = 54571;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/authorize`;
const USAGE_HOST = "https://grow-normal.traeapi.us";

export async function createLoginSession(options = {}) {
  const port = options.port || PORT;
  const redirectUri = `http://127.0.0.1:${port}/authorize`;
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const traceId = crypto.randomUUID();
  const machineId = options.machineId || crypto.randomUUID();
  const deviceId = options.deviceId || String(Math.floor(1000000000000000 + Math.random() * 9000000000000000));

  const authUrl = `https://www.trae.ai/authorization?login_version=1&auth_from=trae&login_channel=native_ide&plugin_version=2.3.73738&auth_type=local&client_id=${CLIENT_ID}&redirect=0&login_trace_id=${traceId}&auth_callback_url=${encodeURIComponent(redirectUri)}&machine_id=${machineId}&device_id=${deviceId}&x_device_id=${deviceId}&x_machine_id=${machineId}&x_device_brand=MacBookPro17,1&x_device_type=mac&x_os_version=macOS%2015.7.8&x_app_version=3.5.91&x_app_type=stable&code_challenge=${challenge}&code_challenge_method=S256&channel_name=common`;

  let resolveResult;
  let rejectResult;
  const promise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
      if (parsedUrl.pathname !== "/authorize") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const code = parsedUrl.searchParams.get("code");
      const error = parsedUrl.searchParams.get("error");
      const errorDescription = parsedUrl.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h2>❌ 授权失败</h2><p>${error}: ${errorDescription || ""}</p>`);
        rejectResult(new Error(`OAuth Error: ${error} - ${errorDescription}`));
        server.close();
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h2>❌ 未获取到授权码 (Code)</h2>");
        rejectResult(new Error("Missing authorization code"));
        server.close();
        return;
      }

      // Exchange authorization code for tokens
      const tokenResp = await fetch(`${USAGE_HOST}/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "xAppId": APP_ID,
          "User-Agent": "TTNetwork PC"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: code,
          code_verifier: verifier,
          redirect_uri: redirectUri
        })
      });

      if (!tokenResp.ok) {
        const errBody = await tokenResp.text().catch(() => "");
        res.writeHead(tokenResp.status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h2>❌ Token 兑换失败: HTTP ${tokenResp.status}</h2><pre>${errBody}</pre>`);
        rejectResult(new Error(`Token exchange failed (${tokenResp.status}): ${errBody}`));
        server.close();
        return;
      }

      const data = await tokenResp.json();
      const credentials = {
        accessToken: data?.accessToken || data?.token || data?.access_token,
        refreshToken: data?.refreshToken || data?.refresh_token,
        userId: data?.user?.userId || data?.userId || "",
        deviceId,
        machineId,
        deviceBrand: "MacBookPro17,1",
        userScope: data?.userScope || "marscode",
        raw: data
      };

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Trae 授权成功</title></head>
        <body style="font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh; background: #0f172a; color: #f8fafc;">
          <div style="background: #1e293b; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 480px;">
            <div style="font-size: 3rem; margin-bottom: 1rem;">🎉</div>
            <h2 style="margin: 0 0 0.5rem; color: #38bdf8;">Trae 授权成功！</h2>
            <p style="color: #94a3b8; font-size: 0.95rem;">Token 凭据已成功由网关助手截获，您可以关闭此浏览器标签页，返回终端查看。</p>
          </div>
        </body>
        </html>
      `);

      resolveResult(credentials);
      server.close();
    } catch (e) {
      rejectResult(e);
      server.close();
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));

  return {
    authUrl,
    port,
    redirectUri,
    promise,
    close: () => server.close()
  };
}

// CLI direct run support
const isDirectRun = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("login-trae.js")
);

if (isDirectRun) {
  try {
    const session = await createLoginSession();
    console.log("\n=======================================================");
    console.log("🚀 ByteDance Trae 登录授权服务已在本地就绪！");
    console.log(`回环监听端口: http://127.0.0.1:${session.port}/authorize`);
    console.log("-------------------------------------------------------");
    console.log(`\n👉 请在浏览器中打开以下授权链接进行登录：\n\n${session.authUrl}\n`);
    console.log("等待浏览器登录完成授权中...\n");

    const creds = await session.promise;
    console.log("================== ✅ Trae 授权成功 ==================");
    console.log(JSON.stringify({
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      userId: creds.userId,
      deviceId: creds.deviceId,
      machineId: creds.machineId,
      deviceBrand: creds.deviceBrand
    }, null, 2));
    console.log("=======================================================\n");

    // Optional: write to .trae_credentials.json in root
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const credPath = path.join(rootDir, ".trae_credentials.json");
    await fs.writeFile(credPath, JSON.stringify(creds, null, 2), "utf-8");
    console.log(`凭据已自动写入本地临时凭证文件: ${credPath}\n`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ 登录失败:", err.message);
    process.exit(1);
  }
}
