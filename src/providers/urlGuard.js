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
  }

  return u;
}

// M1 修复（正确版）：把校验与连接合并为**同一次**解析，根除 DNS TOCTOU / rebinding。
//
// 此前 assertPublicHttps 解析一次、Node 的 fetch 再解析一次 —— 两次独立查询之间，
// 攻击者可用 TTL=0 的 DNS 把结果切到 169.254.169.254 / 127.0.0.1，而请求携带
// Authorization / x-api-key → SSRF + 上游密钥外泄。
//
// 注意：**不能**用每请求 `fetch(url, { dispatcher })` 来 pin —— 实测（Node v22）
// 全局 fetch 不认 `dispatcher` 选项，会抛 `invalid onRequestStart method`。
// 正确做法是把它作为**全局 dispatcher** 的 connect.lookup（见 server.js），
// 该 lookup 会被 fetch 采纳，且连接池共用（无每请求 Agent 开销）。
//
// 语义：任何非公网解析结果一律拒绝（fail-closed），从而「校验通过的 IP」==
// 「实际连接的 IP」。字面量 IP 直接放行（无需 DNS，不可劫持）。
export function makeSafeLookup() {
  return function safeLookup(hostname, options, callback) {
    const done = (err, address, family) => {
      // undici 以 { all: true } 调用 lookup，回调必须回数组形式；否则报
      // `Invalid IP address: undefined`。此处统一按 options.all 归一。
      if (options && options.all) {
        if (err) return callback(err);
        return callback(null, [{ address, family }]);
      }
      return callback(err, address, family);
    };

    // 字面量 IP：直接放行（isPrivateHostname 已在 assertPublicHttps 前置拦截）
    if (ipaddr.isValid(unbracket(hostname))) {
      const family = ipaddr.IPv6.isValid(unbracket(hostname)) ? 6 : 4;
      return done(null, unbracket(hostname), family);
    }

    lookupCached(hostname).then((addresses) => {
      const safe = (addresses || []).find(({ address }) => !isPrivateHostname(address));
      if (!safe) {
        // 全部解析到私网 / 无结果 → 拒绝连接（不降级为「放行」）
        return callback(new Error(`Refusing to connect non-public host: ${hostname}`));
      }
      const wantFamily = options && options.family ? options.family : 0;
      if (wantFamily && wantFamily !== safe.family) {
        return callback(new Error(`Refusing to connect ${hostname}: no validated family ${wantFamily}`));
      }
      return done(null, safe.address, safe.family);
    }).catch((e) => callback(e));
  };
}

// 护栏只校验【初始 URL】。fetch 默认 redirect:"follow" 会自行跟随后续跳转，
// 而跳转目标不经本模块——一个合法公网 https 上游回 302 Location: http://169.254.169.254/...
// 即可把请求送进云 metadata。故所有出站 fetch 必须显式 redirect:"manual"：
// 3xx 不再被自动跟随，护栏的"仅初始 URL 可信"前提才成立。
// 用法：fetch(url, { ...outboundFetchInit("providerId"), method, headers, body, signal })
export function outboundFetchInit(label) {
  return { redirect: "manual", label };
}
