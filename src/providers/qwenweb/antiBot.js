// Qwen 反爬原语的 JS 移植 —— 逐行对齐上游 MIT 实现（qwen-reverse cookies.py /
// fingerprint.py / bxua.py），行为差异即 bug。用途：无浏览器依赖地生成
// ssxmod_itna 系 cookie、37 段指纹、bx-ua 签名，供 qwenweb provider 复用。
// 所有随机与时间均可注入（randInt/now），供黄金向量交叉验证与单测确定性。
// 注意：bx-ua 用 node:crypto（AES-CBC/PKCS7 + sha256/md5），Workers 侧需
// compatibility_flags 含 nodejs_compat（见 wrangler.jsonc）。
import { createCipheriv, createHash } from "node:crypto";

export const CUSTOM_BASE64_CHARS = "DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ";

// LZW 变体压缩（upstream lzw_compress 的 bit-exact 移植；小整数域，JS 32 位运算安全）
export function lzwCompress(data, bits, charFunc) {
  if (data == null) return "";
  const dictionary = new Map();
  const dictToCreate = new Set();
  let w = "";
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result = [];
  let value = 0;
  let position = 0;
  const emit = (bit) => {
    value = (value << 1) | bit;
    if (position === bits - 1) {
      position = 0;
      result.push(charFunc(value));
      value = 0;
    } else {
      position += 1;
    }
  };
  const emitRaw8 = (charCode) => {
    for (let i = 0; i < numBits; i++) emit(0);
    for (let i = 0; i < 8; i++) { emit(charCode & 1); charCode >>= 1; }
  };
  const emitRaw16 = (charCode) => {
    emit(1);
    for (let i = 1; i < numBits; i++) emit(0);
    for (let i = 0; i < 16; i++) { emit(charCode & 1); charCode >>= 1; }
  };
  const emitDict = (code) => {
    for (let i = 0; i < numBits; i++) { emit(code & 1); code >>= 1; }
  };
  const grow = () => {
    enlargeIn -= 1;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits += 1;
    }
  };
  // 注意：新字符分支 decrement 两次（分支内一次 + 共享一次），命中分支一次——与上游缩进语义对齐
  for (const c of data) {
    if (!dictionary.has(c)) {
      dictionary.set(c, dictSize);
      dictSize += 1;
      dictToCreate.add(c);
    }
    const wc = w + c;
    if (dictionary.has(wc)) {
      w = wc;
    } else {
      if (dictToCreate.has(w)) {
        if (w.codePointAt(0) < 256) emitRaw8(w.codePointAt(0));
        else emitRaw16(w.codePointAt(0));
        dictToCreate.delete(w);
        grow();
      } else {
        emitDict(dictionary.get(w));
      }
      grow();
      dictionary.set(wc, dictSize);
      dictSize += 1;
      w = c;
    }
  }
  if (w !== "") {
    if (dictToCreate.has(w)) {
      if (w.codePointAt(0) < 256) emitRaw8(w.codePointAt(0));
      else emitRaw16(w.codePointAt(0));
      dictToCreate.delete(w);
      grow();
    } else {
      emitDict(dictionary.get(w));
    }
    grow();
  }
  emitDict(2);
  while (true) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position += 1;
  }
  return result.join("");
}

export function customEncode(data, urlSafe) {
  if (data == null) return "";
  const compressed = lzwCompress(data, 6, (index) => CUSTOM_BASE64_CHARS[index]);
  if (!urlSafe) {
    const mod = compressed.length % 4;
    if (mod === 1) return compressed + "===";
    if (mod === 2) return compressed + "==";
    if (mod === 3) return compressed + "=";
    return compressed;
  }
  return compressed;
}

const defaultRandInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export const FINGERPRINT_TEMPLATE = {
  deviceId: "84985177a19a010dea49",
  sdkVersion: "websdk-2.3.15d",
  initTimestamp: "1765348410850",
  field3: "91",
  field4: "1|15",
  language: "zh-CN",
  timezoneOffset: "-480",
  colorDepth: "16705151|12791",
  screenInfo: "1470|956|283|797|158|0|1470|956|1470|798|0|0",
  field9: "5",
  platform: "MacIntel",
  field11: "10",
  webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)",
  field13: "30|30",
  field14: "0",
  field15: "28",
  pluginCount: "5",
  vendor: "Google Inc.",
  field29: "8",
  touchInfo: "-1|0|0|0|0",
  field32: "11",
  field35: "0",
  mode: "P"
};

export const SCREEN_PRESETS = {
  "1920x1080": "1920|1080|283|1080|158|0|1920|1080|1920|922|0|0",
  "2560x1440": "2560|1440|283|1440|158|0|2560|1440|2560|1282|0|0",
  "1470x956": "1470|956|283|797|158|0|1470|956|1470|798|0|0",
  "1440x900": "1440|900|283|900|158|0|1440|900|1440|742|0|0",
  "1536x864": "1536|864|283|864|158|0|1536|864|1536|706|0|0"
};

export const PLATFORM_PRESETS = {
  macIntel: {
    platform: "MacIntel",
    webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)",
    vendor: "Google Inc."
  },
  macM1: {
    platform: "MacIntel",
    webglRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)|Google Inc. (Apple)",
    vendor: "Google Inc."
  },
  win64: {
    platform: "Win32",
    webglRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)|Google Inc. (NVIDIA)",
    vendor: "Google Inc."
  },
  linux: {
    platform: "Linux x86_64",
    webglRenderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 630, OpenGL 4.6)|Google Inc. (Intel)",
    vendor: "Google Inc."
  }
};

export const LANGUAGE_PRESETS = {
  "zh-CN": { language: "zh-CN", timezoneOffset: "-480" },
  "zh-TW": { language: "zh-TW", timezoneOffset: "-480" },
  "en-US": { language: "en-US", timezoneOffset: "480" },
  "ja-JP": { language: "ja-JP", timezoneOffset: "-540" },
  "ko-KR": { language: "ko-KR", timezoneOffset: "-540" }
};

export function generateDeviceId(randomHex = null) {
  const pick = randomHex || (() => "0123456789abcdef"[Math.floor(Math.random() * 16)]);
  let out = "";
  for (let i = 0; i < 20; i++) out += pick();
  return out;
}

// 37 段指纹（upstream generate_fingerprint 字段顺序逐项对齐）
export function generateFingerprint(options = {}) {
  const { platform, screen, locale, custom, deviceId, randInt = defaultRandInt, now = Date.now } = options;
  const config = { ...FINGERPRINT_TEMPLATE };
  if (platform && PLATFORM_PRESETS[platform]) Object.assign(config, PLATFORM_PRESETS[platform]);
  if (screen && SCREEN_PRESETS[screen]) config.screenInfo = SCREEN_PRESETS[screen];
  if (locale && LANGUAGE_PRESETS[locale]) Object.assign(config, LANGUAGE_PRESETS[locale]);
  if (custom && typeof custom === "object") Object.assign(config, custom);
  const did = deviceId || generateDeviceId();
  const ts = now();
  const pluginHash = randInt(0, 0xffffffff);
  const canvasHash = randInt(0, 0xffffffff);
  const uaHash1 = randInt(0, 0xffffffff);
  const uaHash2 = randInt(0, 0xffffffff);
  const urlHash = randInt(0, 0xffffffff);
  const docHash = randInt(10, 100);
  const fields = [
    did, config.sdkVersion, config.initTimestamp, config.field3,
    config.field4, config.language, config.timezoneOffset, config.colorDepth,
    config.screenInfo, config.field9, config.platform, config.field11,
    config.webglRenderer, config.field13, config.field14, config.field15,
    `${config.pluginCount}|${pluginHash}`, canvasHash, uaHash1,
    "1", "0", "1", "0", config.mode, "0", "0", "0", "416",
    config.vendor, config.field29, config.touchInfo, uaHash2,
    config.field32, ts, urlHash, config.field35, docHash
  ];
  return fields.map(String).join("^");
}

// ssxmod cookie 对（upstream generate_cookies 逐行对齐；HASH_FIELDS 顺序固定）
const HASH_FIELD_ORDER = [[16, "split"], [17, "full"], [18, "full"], [31, "full"], [34, "full"], [36, "full"]];

export function generateCookies(fingerprint, { randInt = defaultRandInt, now = Date.now } = {}) {
  const fp = fingerprint;
  const fields = fp.split("^");
  const processed = [...fields];
  const ts = now();
  for (const [idx, typ] of HASH_FIELD_ORDER) {
    if (idx >= processed.length) continue;
    if (typ === "split") {
      const parts = String(processed[idx]).split("|");
      if (parts.length === 2) processed[idx] = `${parts[0]}|${randInt(0, 0xffffffff)}`;
    } else if (typ === "full") {
      processed[idx] = idx === 36 ? randInt(10, 100) : randInt(0, 0xffffffff);
    }
  }
  if (33 < processed.length) processed[33] = ts;
  const data = processed.map(String).join("^");
  const itna2 = [
    processed[0], processed[1], processed[23],
    0, "", 0, "", "", 0, 0, 0,
    processed[32], processed[33], 0, 0, 0, 0, 0
  ].map(String).join("^");
  return {
    ssxmod_itna: "1-" + customEncode(data, true),
    ssxmod_itna2: "1-" + customEncode(itna2, true),
    timestamp: Number(processed[33]),
    rawData: data,
    rawData2: itna2
  };
}

// bx-ua 签名（upstream BXUAGenerator逐行对齐）：payload JSON 紧凑序列化 →
// key/iv 取 sha256(seed) 前/后 16 字节 → AES-128-CBC/PKCS7 → base64，前缀 "231!"。
// seed 默认 fingerprint 本体；rnd/timestamp 可注入以复现黄金向量。
export const BXUA_VERSION = "231";

export function bxuaKeyIv(seed) {
  const h = createHash("sha256").update(seed, "utf8").digest();
  return { key: h.subarray(0, 16), iv: h.subarray(16, 32) };
}

export function bxuaPayload(fingerprint, { timestamp = Date.now(), rnd = null, randInt = defaultRandInt } = {}) {
  const fields = fingerprint.split("^");
  const r = rnd ?? randInt(1000, 9999);
  const payload = {
    v: BXUA_VERSION,
    ts: timestamp,
    fp: fingerprint,
    d: {
      deviceId: fields[0],
      sdkVer: fields[1],
      lang: fields[5],
      tz: fields[6],
      platform: fields[10],
      renderer: fields[12],
      mode: fields[23],
      vendor: fields[28]
    },
    rnd: r,
    seq: 1
  };
  payload.cs = createHash("md5").update(`${fingerprint}${timestamp}${r}`, "utf8").digest("hex").slice(0, 8);
  return payload;
}

export function generateBxUa(fingerprint, { timestamp = Date.now(), rnd = null, seed = null, randInt = defaultRandInt } = {}) {
  const payload = bxuaPayload(fingerprint, { timestamp, rnd, randInt });
  const json = JSON.stringify(payload);
  const { key, iv } = bxuaKeyIv(seed ?? fingerprint);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return `${BXUA_VERSION}!${encrypted.toString("base64")}`;
}

// 完整请求身份组装（对齐上游 _get_headers + _attach_extra_headers）：
// cookie 本地生成；bx-umidtoken 由调用方经 sg-wum 抓取后传入（100 次一换）；
// bx-ua 每次新生成；token 有则带 Bearer。randInt/now 可注入供单测确定性。
export function uuid4(randInt = null) {
  const r = randInt || ((min, max) => Math.floor(Math.random() * (max - min + 1)) + min);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const n = r(0, 15);
    return (c === "x" ? n : ((n & 0x3) | 0x8)).toString(16);
  });
}

export function headersFromParts({ cookie, bxua, umidtoken = "", token = "", userAgent = null, randInt } = {}) {
  const headers = {

    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Origin": "https://chat.qwen.ai",
    "Referer": "https://chat.qwen.ai/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Connection": "keep-alive",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-CH-UA": '"Not?A_Brand";v="24", "Chromium";v="152"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
    "source": "web",
    "Version": "0.2.84",
    "X-Accel-Buffering": "no",
    "User-Agent": userAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Cookie": cookie,
    "bx-v": "2.5.37",
    "X-Request-Id": uuid4(randInt),
    "bx-ua": bxua
  };
  if (umidtoken) headers["bx-umidtoken"] = umidtoken;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export function assembleRequestHeaders({ deviceId, token = "", umidtoken = "", userAgent = null, randInt, now } = {}) {
  const identity = mintIdentity({ deviceId, randInt, now });
  return {
    headers: headersFromParts({
      cookie: identity.cookie,
      bxua: identity.bxua,
      umidtoken, token, userAgent, randInt
    }),
    fingerprint: identity.fingerprint
  };
}

// 身份包：一次 mint 产出请求所需的全部合成身份（cookie 对 + bx-ua + 指纹串）。
// deviceId 由调用方稳定持有；umidtoken 需调用方另行抓取传入（100 次一换见 provider）。
// timestamp 统一，保證 cookie/签名时间一致（真浏览器行为）。
export function mintIdentity({ deviceId, randInt, now } = {}) {
  const ts = now?.() ?? Date.now();
  const fp = generateFingerprint({ deviceId, randInt, now: () => ts });
  const ck = generateCookies(fp, { randInt, now: () => ts });
  return {
    deviceId: fp.split("^", 1)[0],
    fingerprint: fp,
    cookie: `ssxmod_itna=${ck.ssxmod_itna};ssxmod_itna2=${ck.ssxmod_itna2}`,
    bxua: generateBxUa(fp, { timestamp: ts }),
    mintedAt: ts
  };
}
