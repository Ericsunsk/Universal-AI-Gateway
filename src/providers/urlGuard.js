// 上游 URL 护栏（providers 内共享，core 不可见）—— openai/anthropic 兼容上游的
// baseUrl/balanceUrl 取自 KV 存量配置，零校验即 SSRF + key 外泄。
//
// 策略：仅允许 https 公网；拒绝 localhost/内网/metadata（169.254.169.254）。
// 依托工业级 ipaddr.js 库处理 IPv4/IPv6 RFC 6890 / 4291 / CGNAT 各种边界，不做脆弱的手写位运算。
import ipaddr from "ipaddr.js";
import dns from "node:dns/promises";

// DNS 解析缓存（性能优化 #5）：避免每次请求都查询 DNS（~50ms）
const dnsCache = new Map();
const DNS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DNS_CACHE_MAX_SIZE = 100;

async function lookupCached(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL_MS) {
    return cached.addresses;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  dnsCache.set(hostname, { addresses, timestamp: Date.now() });

  // LRU 清理
  if (dnsCache.size > DNS_CACHE_MAX_SIZE) {
    const firstKey = dnsCache.keys().next().value;
    dnsCache.delete(firstKey);
  }

  return addresses;
}

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

export async function assertPublicHttps(rawUrl, label) {
  let u = null;
  try { u = new URL(rawUrl); } catch { /* fallthrough */ }
  if (!u || u.protocol !== "https:" || isPrivateHostname(u.hostname)) {
    throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
  }

  if (!ipaddr.isValid(unbracket(u.hostname))) {
    let addresses;
    try {
      addresses = await lookupCached(u.hostname);
    } catch {
      throw new Error(`Refusing to fetch unresolved upstream URL for ${label}`);
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateHostname(address))) {
      throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
    }

    // DNS pinning：用解析出的第一个 IP 替换 hostname（向后兼容清理：移除旧接口）
    const pinnedIp = addresses[0].address;
    const pinnedHost = addresses[0].family === 6 ? `[${pinnedIp}]` : pinnedIp;
    const pinnedUrl = new URL(u.toString());
    pinnedUrl.hostname = pinnedHost;

    return { url: pinnedUrl, sni: u.hostname };
  }

  // 已经是 IP 字面量，无需 pinning
  return { url: u, sni: null };
}

/**
 * DNS rebinding 防护版本：验证 URL 并返回 DNS-pinned 结果。
 *
 * 防护原理：
 * 1. 对域名执行 DNS 解析并验证所有 IP 为公网地址
 * 2. 将 hostname 替换为解析出的第一个 IP（DNS pinning）
 * 3. 返回 pinned URL + 原始 hostname（用于 TLS SNI 和 Host header）
 *
 * 这样可以避免 TOCTOU 窗口：验证通过后、fetch 执行前，攻击者无法通过修改 DNS
 * 将请求重定向到内网（因为 fetch 直接使用已验证的 IP）。
 *
 * @param {string} rawUrl - 待验证的 URL
 * @param {string} label - 标识符（用于错误消息）
 * @returns {Promise<{url: URL, sni: string|null}>}
 *   - url: DNS-pinned URL（域名已替换为 IP）
 *   - sni: 原始 hostname（用于 TLS SNI），IP 字面量时为 null
 */
export async function assertPublicHttpsWithPinning(rawUrl, label) {
  let u = null;
  try { u = new URL(rawUrl); } catch { /* fallthrough */ }
  if (!u || u.protocol !== "https:" || isPrivateHostname(u.hostname)) {
    throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
  }

  if (!ipaddr.isValid(unbracket(u.hostname))) {
    let addresses;
    try {
      addresses = await lookupCached(u.hostname);
    } catch {
      throw new Error(`Refusing to fetch unresolved upstream URL for ${label}`);
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateHostname(address))) {
      throw new Error(`Refusing to fetch non-public upstream URL for ${label}`);
    }

    // DNS pinning：用解析出的第一个 IP 替换 hostname
    const pinnedIp = addresses[0].address;
    const pinnedHost = addresses[0].family === 6 ? `[${pinnedIp}]` : pinnedIp;
    const pinnedUrl = new URL(u.toString());
    pinnedUrl.hostname = pinnedHost;

    return { url: pinnedUrl, sni: u.hostname };
  }

  // 已经是 IP 字面量，无需 pinning
  return { url: u, sni: null };
}

// 护栏只校验【初始 URL】。fetch 默认 redirect:"follow" 会自行跟随后续跳转，
// 而跳转目标不经本模块——一个合法公网 https 上游回 302 Location: http://169.254.169.254/...
// 即可把请求送进云 metadata。故所有出站 fetch 必须显式 redirect:"manual"：
// 3xx 不再被自动跟随，护栏的"仅初始 URL 可信"前提才成立。
// 用法：fetch(url, { ...outboundFetchInit("providerId"), method, headers, body, signal })
export function outboundFetchInit(label) {
  return { redirect: "manual", label };
}
