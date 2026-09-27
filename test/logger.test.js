import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTraceId, extractTraceId, createLogger, sanitize, setLogSink, runWithLogger, log } from "../src/logging/logger.js";

test("generateTraceId returns 32-char hex string", () => {
  const id = generateTraceId();
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);

  const id2 = generateTraceId();
  assert.notEqual(id, id2, "should generate unique IDs");
});

test("extractTraceId prioritizes headers, returns null when absent", () => {
  const req1 = new Request("https://x/y", {
    headers: { "x-trace-id": "custom-trace-123" }
  });
  assert.equal(extractTraceId(req1), "custom-trace-123");

  const req2 = new Request("https://x/y", {
    headers: { "x-request-id": "req-456" }
  });
  assert.equal(extractTraceId(req2), "req-456");

  const req3 = new Request("https://x/y");
  assert.equal(extractTraceId(req3), null, "absent headers return null; caller generates");
});

test("createLogger outputs structured logs", () => {
  const logs = [];
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  setLogSink((line) => logs.push(line));
  process.env.LOG_FORMAT = "json"; // 强制 JSON 输出
  process.env.NODE_ENV = "production";

  try {
    const logger = createLogger({ trace_id: "test123" });
    logger.info("Test message", { user: "alice" });

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0]);
    assert.equal(entry.level, "INFO");
    assert.equal(entry.message, "Test message");
    assert.equal(entry.trace_id, "test123");
    assert.equal(entry.user, "alice");
    assert.ok(entry.timestamp);
  } finally {
    setLogSink(null);
    if (origFormat !== undefined) process.env.LOG_FORMAT = origFormat;
    else delete process.env.LOG_FORMAT;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("createLogger respects LOG_LEVEL", () => {
  const logs = [];
  const origEnv = process.env.LOG_LEVEL;
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  setLogSink((line) => logs.push(line));
  process.env.LOG_LEVEL = "WARN";
  process.env.LOG_FORMAT = "json";
  process.env.NODE_ENV = "production";

  try {
    const logger = createLogger();
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    assert.equal(logs.length, 2, "should only log WARN and ERROR");
    const warn = JSON.parse(logs[0]);
    const err = JSON.parse(logs[1]);
    assert.equal(warn.message, "warn msg");
    assert.equal(err.message, "error msg");
  } finally {
    setLogSink(null);
    if (origEnv !== undefined) process.env.LOG_LEVEL = origEnv;
    else delete process.env.LOG_LEVEL;
    if (origFormat !== undefined) process.env.LOG_FORMAT = origFormat;
    else delete process.env.LOG_FORMAT;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("createLogger.child inherits parent context", () => {
  const logs = [];
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  setLogSink((line) => logs.push(line));
  process.env.LOG_FORMAT = "json";
  process.env.NODE_ENV = "production";

  try {
    const parent = createLogger({ trace_id: "parent" });
    const child = parent.child({ request_id: "child" });
    child.info("Child log");

    const entry = JSON.parse(logs[0]);
    assert.equal(entry.trace_id, "parent");
    assert.equal(entry.request_id, "child");
  } finally {
    setLogSink(null);
    if (origFormat !== undefined) process.env.LOG_FORMAT = origFormat;
    else delete process.env.LOG_FORMAT;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("sanitize redacts sensitive fields", () => {
  const input = {
    username: "alice",
    password: "secret123",
    apiKey: "sk-1234567890abcdef",
    nested: {
      token: "bearer-xyz",
      data: "public"
    }
  };

  const output = sanitize(input);

  assert.equal(output.username, "alice");
  assert.equal(output.password, "secr****");
  assert.equal(output.apiKey, "sk-1****");
  assert.equal(output.nested.token, "bear****");
  assert.equal(output.nested.data, "public");
});

test("sanitize handles arrays and null", () => {
  const input = {
    items: [
      { token: "abc123", value: 1 },
      { token: "def456", value: 2 }
    ],
    empty: null
  };

  const output = sanitize(input);
  assert.equal(output.items[0].token, "abc1****");
  assert.equal(output.items[1].value, 2);
  assert.equal(output.empty, null);
});

test("sanitize handles short sensitive strings", () => {
  const input = { password: "ab" };
  const output = sanitize(input);
  assert.equal(output.password, "****");
});

test("sanitize normalizes snake/kebab keys and exact key", () => {
  const output = sanitize({ api_key: "sk-1234567890", "x-api-key": "abc", key: "sk-xyz123456", credential: "secret123", monkey: "banana" });
  assert.ok(!output.api_key.includes("1234567890"));
  assert.equal(output["x-api-key"], "****");
  assert.ok(output.key.startsWith("sk-x"));
  assert.ok(!output.credential.includes("secret123"));
  assert.equal(output.monkey, "banana", "monkey must not be killed by substring key");
});

test("sanitize redacts userId, masterKey and cronKey (P1-2 security fix)", () => {
  const input = {
    userId: "user-12345",
    USER_ID: "uid-67890",
    masterKey: "sk-master-secret",
    MASTER_KEY: "master-key-abc",
    cronKey: "cron-key-xyz",
    CRON_SECRET: "cron-secret-123",
    nested: {
      userId: "nested-user",
      masterKey: "nested-master"
    }
  };
  const output = sanitize(input);
  // userId 系列
  assert.ok(output.userId.endsWith("****"), "userId must be redacted");
  assert.ok(!output.userId.includes("12345"), "userId value must not leak");
  assert.ok(output.USER_ID.endsWith("****"), "USER_ID must be redacted");
  // masterKey 系列
  assert.ok(output.masterKey.endsWith("****"), "masterKey must be redacted");
  assert.ok(!output.masterKey.includes("secret"), "masterKey value must not leak");
  assert.ok(output.MASTER_KEY.endsWith("****"), "MASTER_KEY must be redacted");
  // cron 系列
  assert.ok(output.cronKey.endsWith("****"), "cronKey must be redacted");
  assert.ok(output.CRON_SECRET.endsWith("****"), "CRON_SECRET must be redacted");
  // 递归脱敏
  assert.ok(output.nested.userId.endsWith("****"), "nested userId must be redacted");
  assert.ok(output.nested.masterKey.endsWith("****"), "nested masterKey must be redacted");
});

test("sanitize cache returns same object for repeated calls (perf optimization #3)", () => {
  const input = { username: "alice", data: "public" };

  const output1 = sanitize(input);
  const output2 = sanitize(input);

  // 无敏感字段对象应该零拷贝（返回原对象）
  assert.strictEqual(output1, input, "should return original object when no sensitive fields");
  assert.strictEqual(output2, input, "cached result should be same object");
});

test("sanitize respects max depth limit", () => {
  // 构造深度嵌套对象
  let deep = { value: "leaf" };
  for (let i = 0; i < 20; i++) {
    deep = { nested: deep };
  }

  const output = sanitize(deep);

  // 应该在某个深度截断
  let current = output;
  let depth = 0;
  while (current && typeof current === "object" && current.nested) {
    current = current.nested;
    depth++;
    if (depth > 15) break; // 安全阈值
  }

  assert.ok(depth <= 15, "should limit recursion depth");
});

test("runWithLogger propagates trace_id through async depth without threading params", async () => {
  const logs = [];
  setLogSink((line) => logs.push(line));
  try {
    // 中间层刻意不接收任何 logger 参数，验证 ALS 自动传播
    const deep = async () => { await new Promise((r) => { setTimeout(r, 1); }); log.warn("deep", { k: 1 }); };
    const mid = async () => { await deep(); };
    await runWithLogger({ trace_id: "TRACE12345678" }, async () => { await mid(); });
  } finally {
    setLogSink(null);
  }
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("TRACE123"), "trace_id must reach deep async frames");
});

test("log outside any scope falls back to root logger without throwing", () => {
  const logs = [];
  setLogSink((line) => logs.push(line));
  try {
    assert.doesNotThrow(() => log.info("outside scope", { a: 1 }));
  } finally {
    setLogSink(null);
  }
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("outside scope"));
});

test("log redacts credentials on the fields path", () => {
  const logs = [];
  setLogSink((line) => logs.push(line));
  try {
    log.error("boom", { authorization: "Bearer sk-secret123", apiKey: "sk-ant-xyz", ok: 1 });
  } finally {
    setLogSink(null);
  }
  assert.ok(!logs[0].includes("sk-secret123"), "raw bearer token must not be logged");
  assert.ok(!logs[0].includes("sk-ant-xyz"), "raw api key must not be logged");
  assert.ok(logs[0].includes("ok"));
});

test("log level is resolved at emit time, not construction time", () => {
  const logs = [];
  const orig = process.env.DEBUG;
  setLogSink((line) => logs.push(line));
  try {
    // rootLogger 在模块加载时已建立；此处改变 DEBUG 后仍应生效
    delete process.env.DEBUG;
    log.debug("should be suppressed");
    process.env.DEBUG = "true";
    log.debug("should now appear");
  } finally {
    setLogSink(null);
    if (orig !== undefined) process.env.DEBUG = orig; else delete process.env.DEBUG;
  }
  assert.equal(logs.length, 1, "only the post-toggle debug line should emit");
  assert.ok(logs[0].includes("should now appear"));
});

// ---- 2026-09-27 审计修复：日志中的 URL query 凭据必须打码 ----
// /checkin?secret=xxx 的 cron 凭据走 query（src/index.js 的 /checkin 路由）。
// 访问日志若记录完整 req.url（键名为中性的 path），仅靠键名匹配无法拦截，
// 故 sanitize 需在值侧做纵深防御：URL 形态的字符串也要打码敏感 query 参数。
test("sanitize redacts sensitive query params in URL-shaped values", () => {
  assert.equal(sanitize({ path: "/checkin?secret=SUPERSECRET123" }).path, "/checkin?secret=****");
  assert.equal(sanitize({ path: "/checkin?cron_secret=SUPERSECRET123" }).path, "/checkin?cron_secret=****");
  assert.equal(sanitize({ path: "/v1/messages?api_key=sk-live-X" }).path, "/v1/messages?api_key=****");
  assert.equal(sanitize({ path: "/x?access_token=tok_1&page=2" }).path, "/x?access_token=****&page=2");
  assert.equal(sanitize({ path: "/x?refresh_token=tok_2&limit=5" }).path, "/x?refresh_token=****&limit=5");
  assert.equal(sanitize({ path: "/x?token=tok_1&page=2" }).path, "/x?token=****&page=2");
  assert.equal(sanitize({ path: "/x?secret=a&secret=b" }).path, "/x?secret=****&secret=****");
  // 非敏感参数保留原值（排障需要）
  assert.equal(sanitize({ path: "/v1/models?page=2&limit=10" }).path, "/v1/models?page=2&limit=10");
});

test("sanitize does not over-redact non-URL strings", () => {
  // 自然语言的问号不是 query
  assert.equal(sanitize({ msg: "What is this? I don't know" }).msg, "What is this? I don't know");
  // 无 query 的路径原样保留
  assert.equal(sanitize({ path: "/v1/messages" }).path, "/v1/messages");
  // 模型输出里的普通 URL（无敏感参数）不得被改写
  const s = "See https://api.example.com/v1/models for info";
  assert.equal(sanitize({ text: s }).text, s);
});

test("access log never leaks the cron secret", () => {
  const logs = [];
  setLogSink((line) => logs.push(line));
  try {
    log.info("HTTP Request", { method: "GET", path: "/checkin?secret=SUPERSECRET123", status: 200 });
  } finally {
    setLogSink(null);
  }
  assert.ok(!logs.join("").includes("SUPERSECRET123"), "cron secret must not reach the log sink");
  assert.ok(logs.join("").includes("secret=****"), "param name should survive for debuggability");
});

test("prematurely closed request logs warning with 499 status", () => {
  const logs = [];
  setLogSink((line) => logs.push(line));
  try {
    log.warn("HTTP Request Closed Prematurely", {
      method: "POST",
      path: "/v1/messages",
      status: 499,
      duration_ms: 1000,
      aborted: true
    });
  } finally {
    setLogSink(null);
  }
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("HTTP Request Closed Prematurely"));
  assert.ok(logs[0].includes("499"));
});

