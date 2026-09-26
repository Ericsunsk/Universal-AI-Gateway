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
