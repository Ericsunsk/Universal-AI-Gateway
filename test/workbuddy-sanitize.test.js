import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeMessages } from "../src/providers/workbuddy/sanitize.js";

// H4：sanitizer 曾使用大小写敏感的 includes，导致全小写指纹（claude code ...）绕过上游 11128 过滤。
// sanitizeText 为模块私有，统一经由导出面 sanitizeMessages(user) 验证。

const FINGERPRINT = "You are Claude Code, Anthropic's official CLI for Claude.";

test("sanitizeMessages rewrites exact-case Claude Code fingerprint", () => {
  const out = sanitizeMessages([{ role: "user", content: FINGERPRINT }]);
  assert.equal(out[0].content, "You are Claude Code, Anthropic's official CLI tool for Claude.");
});

test("sanitizeMessages rewrites lowercased Claude Code fingerprint (case-insensitive)", () => {
  const lower = "you are claude code, anthropic's official cli for claude.";
  const out = sanitizeMessages([{ role: "user", content: lower }]);
  assert.notEqual(out[0].content, lower);
  assert.ok(!out[0].content.includes("official cli for claude"), "fingerprint must be defused regardless of casing");
});

test("sanitizeMessages rewrites mixed-case fingerprint", () => {
  const mixed = "You are claude CODE, Anthropic's Official CLI for Claude.";
  const out = sanitizeMessages([{ role: "user", content: mixed }]);
  assert.ok(out[0].content.includes("official CLI tool for Claude"), "mixed-case fingerprint must be rewritten");
});

test("sanitizeMessages returns the SAME message object for benign content (fast path intact)", () => {
  const msg = { role: "user", content: "just some benign prose about nothing in particular" };
  const out = sanitizeMessages([msg]);
  assert.equal(out[0], msg);
  assert.equal(out[0].content, msg.content);
});

test("sanitizeMessages still fast-skips tool and assistant roles", () => {
  const tool = { role: "tool", content: FINGERPRINT };
  const assistant = { role: "assistant", content: FINGERPRINT };
  const out = sanitizeMessages([tool, assistant]);
  assert.equal(out[0], tool);
  assert.equal(out[1], assistant);
});

test("sanitizeMessages rewrites fingerprint inside array content parts", () => {
  const part = { type: "text", text: "you are claude code, anthropic's official cli for claude." };
  const msg = { role: "user", content: [part] };
  const out = sanitizeMessages([msg]);
  assert.notEqual(out[0], msg);
  assert.ok(!out[0].content[0].text.includes("official cli for claude"));
});
