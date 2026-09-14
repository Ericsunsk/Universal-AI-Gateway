// Qwen 网页版指纹头构造 —— 抓包实测字段为准。
// 鉴权 = cookie（ssxmod_itna 等，由调用方经 Cookie 头透传）+ 下列指纹头。
// bx-ua / bx-umidtoken 为账号绑定的不透明 blob：首次从真实浏览器会话抄录（见 docs 记录流程），
// 存入账号配置复用；失效（WAF 拦截）→ 网关按 429 冷却该账号并告警，人工刷新指纹。
// X-Request-Id / Timezone 每次新生成（真浏览器行为）。

export function buildQwenHeaders({ fingerprint = {}, requestId = null, random = Math.random } = {}) {
  const uuid = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.floor(random() * 16);
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "source": "web",
    "Version": "0.2.91",
    "Timezone": new Date().toString(),
    "X-Request-Id": requestId || uuid(),
    "X-Accel-Buffering": "no",
    "Referer": "https://chat.qwen.ai/",
    "User-Agent": fingerprint.userAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9"
  };
  if (fingerprint.umidtoken) headers["bx-umidtoken"] = fingerprint.umidtoken;
  if (fingerprint.ua) headers["bx-ua"] = fingerprint.ua;
  if (fingerprint.cookie) headers["Cookie"] = fingerprint.cookie;
  return headers;
}
