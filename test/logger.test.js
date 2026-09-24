import { test } from "node:test";
import assert from "node:assert/strict";
import { generateTraceId, extractTraceId, createLogger, sanitize, LogLevel } from "../src/logging/logger.js";

test("generateTraceId returns 32-char hex string", () => {
  const id = generateTraceId();
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);

  const id2 = generateTraceId();
  assert.notEqual(id, id2, "should generate unique IDs");
});

test("extractTraceId prioritizes headers over generation", () => {
  const req1 = new Request("https://x/y", {
    headers: { "x-trace-id": "custom-trace-123" }
  });
  assert.equal(extractTraceId(req1), "custom-trace-123");

  const req2 = new Request("https://x/y", {
    headers: { "x-request-id": "req-456" }
  });
  assert.equal(extractTraceId(req2), "req-456");

  const req3 = new Request("https://x/y");
  const id3 = extractTraceId(req3);
  assert.equal(id3.length, 32, "should generate new ID when no header");
});

test("createLogger outputs structured logs", () => {
  const logs = [];
  const origLog = console.log;
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  console.log = (msg) => logs.push(msg);
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
    console.log = origLog;
    if (origFormat !== undefined) process.env.LOG_FORMAT = origFormat;
    else delete process.env.LOG_FORMAT;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test("createLogger respects LOG_LEVEL", () => {
  const logs = [];
  const origLog = console.log;
  const origEnv = process.env.LOG_LEVEL;
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  console.log = (msg) => logs.push(msg);
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
    console.log = origLog;
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
  const origLog = console.log;
  const origFormat = process.env.LOG_FORMAT;
  const origNodeEnv = process.env.NODE_ENV;
  console.log = (msg) => logs.push(msg);
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
    console.log = origLog;
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
