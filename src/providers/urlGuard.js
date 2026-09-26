// 上游 URL 护栏（providers 内共享，core 不可见）—— openai/anthropic 兼容上游的
// baseUrl/balanceUrl 取自 KV 存量配置，零校验即 SSRF + key 外泄。
//
// 策略：仅允许 https 公网；拒绝 localhost/内网/metadata（169.254.169.254）。
//
// 判定必须在**解析后**的 hostname 上做，不能匹配原始字符串：URL 解析器会把各种
// 非十进制字面量归一化为 IPv4，字符串层的黑名单永远追不上。例如下面这些都解析到
// 127.0.0.1 / 169.254.169.254，但原样匹配前缀一个也拦不住：
//   2852039166 · 2130706433 · 0x7f000001 · 0177.0.0.1 · 0x7f.0.0.1 · 127.1
// 因此这里统一走 new URL() 归一化 + 按段分类，不做字面量枚举。
//
// 边界：仅拦字面量 IP 与已知内网域名后缀。**域名解析后的真实 IP 不校验**，
// 故 DNS-rebinding / 内网域名解析（如 *.nip.io、内网 DNS）仍可绕过——
// 彻底修复需在 fetch 层对已解析连接做二次校验（或禁用重定向后重校验）。
import { isIP } from "node:net";

// 去掉 IPv6 字面量的方括号（new URL 的 hostname 形如 "[::ffff:7f00:1]"）。
function unbracket(hostname) {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

// IPv6 私有/回环/链路本地/组播/唯一本地判定（去括号后的裸地址）。
function isPrivateIpv6(addr) {
  const a = addr.toLowerCase();
  if (a === "::1" || a === "::") return true;
  // IPv4-mapped (::ffff:x.x.x.x) 与 IPv4-compatible (::x.x.x.x)：取尾部 IPv4 再判。
  const v4 = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) return isPrivateIpv4(v4[1]);
  // ::ffff:7f00:1 这类十六进制结尾的 mapped 形式（URL 归一化后常见）。
  const hexMapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
  }
  // 展开为 8 组 16 位，按首个 hextet 的位做完整判定（不用字符串前缀近似）。
  const expanded = expandIpv6(a);
  if (expanded) {
    const h0 = expanded[0];
    if ((h0 & 0xfe00) === 0xfc00) return true;  // fc00::/7  唯一本地
    if ((h0 & 0xffc0) === 0xfe80) return true;  // fe80::/10 链路本地
    if ((h0 & 0xff00) === 0xff00) return true;  // ff00::/8  组播
    if (h0 === 0x2001 && expanded[1] === 0x0db8) return true; // 2001:db8::/32 文档用
    if (h0 === 0x2002) return true;             // 2002::/16 6to4（可封装内网 v4）
  }
  return false;
}

// 把 IPv6 文本展开为 8 个 16 位整数；无法解析返回 null（调用方按「非私有」放行由 isIP 保证）。
function expandIpv6(a) {
  const [head, tail] = a.includes("::") ? a.split("::") : [a, null];
  const hp = head ? head.split(":").filter(Boolean) : [];
  const tp = tail !== null && tail !== undefined
    ? (tail ? tail.split(":").filter(Boolean) : [])
    : null;
  if (hp.some(g => g.length > 4) || (tp || []).some(g => g.length > 4)) return null;
  let groups;
  if (tp === null) {
    if (hp.length !== 8) return null;
    groups = hp;
  } else {
    const fill = 8 - hp.length - tp.length;
    if (fill < 0) return null;
    groups = [...hp, ...Array(fill).fill("0"), ...tp];
  }
  const nums = groups.map(g => parseInt(g || "0", 16));
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// IPv4 非公网段判定（输入应为已归一化的点分十进制）。
// 覆盖 RFC 6890 特殊用途地址中**不可全局路由**的全部区间：SSRF 护栏必须 fail-closed，
// 凡「不是明确的公网单播」一律拒绝，而非仅拦 RFC1918 三段。
function isPrivateIpv4(addr) {
  const p = addr.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0) return true;                            // 0.0.0.0/8    "this network"
  if (a === 10) return true;                           // 10.0.0.0/8   私有 A
  if (a === 127) return true;                          // 127.0.0.0/8  回环
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 链路本地 / 云 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 私有 B
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16 私有 C
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && c === 2) return true;    // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;  // 192.88.99.0/24 6to4 中继任播
  if (a === 198 && b >= 18 && b <= 19) return true;    // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;  // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true;                           // 224.0.0.0/4 组播 + 240.0.0.0/4 保留 + 广播
  return false;
}

export function isPrivateHostname(hostname) {
  const raw = String(hostname || "").trim();
  if (raw === "") return true;
  const h = unbracket(raw.toLowerCase()).replace(/\.$/, "");
  if (h === "" || h === "localhost") return true;
  const v = isIP(h);
  if (v === 6) return isPrivateIpv6(h);
  if (v === 4) return isPrivateIpv4(h);
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
