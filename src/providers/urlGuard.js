// 上游 URL 护栏（providers 内共享，core 不可见）—— openai/anthropic 兼容上游的
// baseUrl/balanceUrl 取自 KV 存量配置，零校验即 SSRF + key 外泄。
// 策略：仅允许 https 公网；拒绝 localhost/内网/metadata（169.254.169.254）。
// 注：防不住 DNS-rebinding（需解析后二次校验），此处为静态护栏。
export function isPrivateHostname(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^0\.0\.0\.0$/.test(h) || /^::(:ffff:0:0:)?0\.0\.0\.0$/.test(h)) return true;
  if (h.includes(":") && (/^(fc[0-9a-f]{2}|fd)/.test(h.replace(/:/g, "")) || /^fe[89ab][0-9a-f]/i.test(h.replace(/:/g, "")))) return true;
  if (/^[a-z0-9-]+\.local$/i.test(h) || /^[a-z0-9-]+\.internal$/i.test(h)) return true;
  return false;
}

export function assertPublicHttps(rawUrl, label) {
  let u = null;
  try { u = new URL(rawUrl); } catch (e) { /* fallthrough */ }
  if (!u || u.protocol !== "https:" || isPrivateHostname(u.hostname)) {
    throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
  }
  return u;
}
