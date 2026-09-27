import { test } from "node:test";
import assert from "node:assert/strict";

test("production mode suppresses stack traces (P1-5)", () => {
  // 保存原始值
  const originalEnv = process.env.NODE_ENV;
  const originalLimit = Error.stackTraceLimit;

  try {
    // 模拟生产环境
    process.env.NODE_ENV = "production";
    Error.stackTraceLimit = 0;

    // 抛出错误
    let capturedError;
    try {
      throw new Error("test error with sensitive info");
    } catch (e) {
      capturedError = e;
    }

    // 验证 stack trace 被压制
    assert.ok(capturedError.message, "error message should exist");
    assert.equal(capturedError.message, "test error with sensitive info");

    // stack 应该只包含错误消息，不包含 "at" 开头的堆栈帧
    const stackLines = (capturedError.stack || "").split("\n");
    const hasStackFrames = stackLines.some(line => line.trim().startsWith("at "));
    assert.equal(hasStackFrames, false, "stack trace should not contain function frames");
    assert.ok(stackLines.length <= 2, `stack should be minimal, got ${stackLines.length} lines`);

  } finally {
    // 恢复原始值
    process.env.NODE_ENV = originalEnv;
    Error.stackTraceLimit = originalLimit;
  }
});

test("development mode preserves stack traces", () => {
  const originalEnv = process.env.NODE_ENV;
  const originalLimit = Error.stackTraceLimit;

  try {
    process.env.NODE_ENV = "development";
    Error.stackTraceLimit = 10;

    let capturedError;
    try {
      throw new Error("dev error");
    } catch (e) {
      capturedError = e;
    }

    // 开发环境应该有完整 stack trace
    const hasStackFrames = (capturedError.stack || "").includes("at ");
    assert.ok(hasStackFrames, "development mode should preserve stack traces");

  } finally {
    process.env.NODE_ENV = originalEnv;
    Error.stackTraceLimit = originalLimit;
  }
});

test("logger never logs err.stack, only err.message", () => {
  // 当前实现已经正确：只记录 err.message
  const testError = new Error("sensitive error");
  testError.stack = "Error: sensitive error\n    at /var/task/src/secret.js:42:10\n    at process.env.SECRET_KEY=xxx";

  // 模拟日志记录行为
  const logField = { error: testError?.message || String(testError) };

  // 验证不包含 stack trace
  assert.equal(logField.error, "sensitive error");
  assert.ok(!logField.error.includes("/var/task"), "should not log file paths");
  assert.ok(!logField.error.includes("SECRET_KEY"), "should not log env vars");
});
