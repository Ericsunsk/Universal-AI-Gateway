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
// 上游总时长上界（非流式路径）。流式由 stream.js 的 UPSTREAM_STALL_MS(180s) 按「无字节时长」
// 熔断；非流式此前**无任何上界** —— 上游若建连成功却永不返回 body，请求会一直占用并发槽位
// 直到平台 wall-clock 上限（Vercel 300s）。此处按总时长封顶，与流式量级对齐。
//
// 取 240s：低于 Vercel 的 300s 上限，留出响应转译与回写余量；高于实测最慢模型（118s），
// 不误杀正常长响应。可用 env 覆盖（测试注入小值）。
const UPSTREAM_TIMEOUT_MS = 240 * 1000;

// 合并调用方的 signal（客户端中断）与服务端超时：任一触发即中止。
// 不能直接用 AbortSignal.any（Node 18 缺失），手写以兼容运行时。
function withUpstreamTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
  if (!timeout) return signal;
  if (!signal) return timeout;
  const ctrl = new AbortController();
  const onAbort = (reason) => { ctrl.abort(reason); cleanup(); };
  const cleanup = () => {
    signal.removeEventListener?.("abort", onAbort);
    timeout.removeEventListener?.("abort", onAbort);
  };
  if (signal.aborted || timeout.aborted) { onAbort(); return ctrl.signal; }
  signal.addEventListener?.("abort", onAbort, { once: true });
  timeout.addEventListener?.("abort", onAbort, { once: true });
  return ctrl.signal;
}

export function outboundFetchInit(label, { signal, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  return { redirect: "manual", label, signal: withUpstreamTimeout(signal, timeoutMs) };
}

// 出站全局连接池 + rebinding 防护的唯一装配入口。
//
// M1 修复的**部署侧**：`connect.lookup` 复用「校验+解析同一次」逻辑，使
// 「校验通过的 IP」== 「实际连接的 IP」，根除 DNS TOCTOU / rebinding。
// 不能改用每请求 dispatcher —— 全局 fetch 不认该选项（实测抛 invalid onRequestStart）。
//
// 必须由**每个**入口调用：此前只在 server.js（本地 npm start）装配，Vercel 生产入口
// api/index.js 从未调用，导致该防护在生产上是死代码。故收敛到此处，双入口共用。
//
// 幂等：重复调用只装配一次（server.js 的 cluster 多 worker 与模块热重载都会重复 import）。
let dispatcherInstalled = false;
export function installSafeDispatcher({ keepAliveTimeout = 60_000, keepAliveMaxTimeout = 300_000, connections = 64 } = {}) {
  if (dispatcherInstalled) return false;
  dispatcherInstalled = true;
  // undici 为运行时依赖（Node 18+ 内置同源实现），动态 import 避免在上游护栏模块
  // 顶层耦合连接池实现——护栏的纯校验函数不关心传输层。
  import("undici").then(({ setGlobalDispatcher, Agent }) => {
    setGlobalDispatcher(new Agent({
      keepAliveTimeout,      // 空闲连接保持 60 秒（覆盖常见人机交互间隔）
      keepAliveMaxTimeout,   // 最长复用 5 分钟
      connections,           // 连接池大小上限
      pipelining: 1,
      connect: { lookup: makeSafeLookup() }
    }));
  }).catch(() => {
    // 装配失败不应让网关起不来：退化为默认 dispatcher（仅失去 rebinding 防护与连接复用）
    dispatcherInstalled = false;
  });
  return true;
}
