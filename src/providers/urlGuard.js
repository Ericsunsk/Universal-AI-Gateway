// 上游 URL 护栏（providers 内共享，core 不可见）—— openai/anthropic 兼容上游的
// baseUrl/balanceUrl 取自 KV 存量配置，零校验即 SSRF + key 外泄。
//
// 策略：仅允许 https 公网；拒绝 localhost/内网/metadata（169.254.169.254）。
// 依托工业级 ipaddr.js 库处理 IPv4/IPv6 RFC 6890 / 4291 / CGNAT 各种边界，不做脆弱的手写位运算。
import ipaddr from "ipaddr.js";

// 去掉 IPv6 字面量的方括号（new URL 的 hostname 形如 "[::ffff:7f00:1]"）。
function unbracket(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

export function isPrivateHostname(hostname) {
  const raw = String(hostname || "").trim();
  if (raw === "") return true;
  const h = unbracket(raw.toLowerCase()).replace(/\.$/, "");
  if (h === "" || h === "localhost") return true;

  if (ipaddr.isValid(h)) {
    let addr = ipaddr.parse(h);
    if (addr.kind() === "ipv6" && addr.isIPv4MappedAddress()) {
      addr = addr.toIPv4Address();
    }
    const range = addr.range();
    // RFC 3879 已废弃 site-local (fec0::/10)，其地址空间重新作为全局公网单播分配，不拦截
    if (range === "deprecatedSiteLocal") return false;
    return range !== "unicast";
  }

  // 非 IP：仅拦已知内网域名后缀（解析后的真实 IP 不在此层校验）。
  if (/\.local$/.test(h) || /\.internal$/.test(h) || /\.localhost$/.test(h)) return true;
  return false;
}

export function assertPublicHttps(rawUrl, label) {
  let u = null;
  try { u = new URL(rawUrl); } catch { /* fallthrough */ }
  if (!u || u.protocol !== "https:" || isPrivateHostname(u.hostname)) {
    throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
  }
  return u;
}
