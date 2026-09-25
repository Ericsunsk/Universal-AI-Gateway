import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeMessages,
  ensureSystemFirstMessage,
  sanitizeWorkbuddyPayload,
  DEFAULT_WORKBUDDY_SYSTEM_PROMPT
} from "../src/providers/workbuddy/sanitize.js";

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

test("sanitizeMessages normalizes developer role to system", () => {
  const msg = { role: "developer", content: "You are an assistant" };
  const out = sanitizeMessages([msg]);
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, "You are an assistant");
});

test("ensureSystemFirstMessage prepends default system prompt if first message is not system", () => {
  const msgs = [{ role: "user", content: "hello" }];
  const out = ensureSystemFirstMessage(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, DEFAULT_WORKBUDDY_SYSTEM_PROMPT);
  assert.equal(out[1].role, "user");
});

test("ensureSystemFirstMessage does not prepend if first message is already system", () => {
  const msgs = [{ role: "system", content: "custom prompt" }, { role: "user", content: "hi" }];
  const out = ensureSystemFirstMessage(msgs);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, "custom prompt");
});

test("ensureSystemFirstMessage leaves empty array unchanged", () => {
  const msgs = [];
  const out = ensureSystemFirstMessage(msgs);
  assert.deepEqual(out, []);
});

test("sanitizeWorkbuddyPayload cleans full OpenAI payload for 11128 compliance", () => {
  const rawPayload = {
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "developer", content: "You are an expert coding assistant operating inside pi, a coding agent harness." },
      { role: "user", content: "Refactor this code" }
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 4096,
    store: false,
    parallel_tool_calls: true,
    prompt_cache_key: "sess-123",
    prompt_cache_retention: "24h",
    user: "user-456",
    tool_choice: { type: "function", function: { name: "edit_file" } },
    tools: [
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "Edit a file",
          parameters: { type: "object", properties: {} },
          strict: false
        }
      }
    ]
  };

  const clean = sanitizeWorkbuddyPayload(rawPayload);

  // 1. developer -> system, and system is first
  assert.equal(clean.messages[0].role, "system");
  assert.equal(clean.messages[0].content, "You are an expert coding assistant operating inside pi, a coding agent harness.");
  assert.equal(clean.messages[1].role, "user");

  // 2. max_completion_tokens mapped to max_tokens
  assert.equal(clean.max_tokens, 4096);
  assert.equal(clean.max_completion_tokens, undefined);

  // 3. unapproved parameters stripped
  assert.equal(clean.stream_options, undefined);
  assert.equal(clean.store, undefined);
  assert.equal(clean.parallel_tool_calls, undefined);
  assert.equal(clean.prompt_cache_key, undefined);
  assert.equal(clean.prompt_cache_retention, undefined);
  assert.equal(clean.user, undefined);

  // 4. tool_choice normalized to string
  assert.equal(clean.tool_choice, "edit_file");

  // 5. tools function strict stripped
  assert.equal(clean.tools[0].function.strict, undefined);
  assert.equal(clean.tools[0].function.name, "edit_file");
});

test("sanitizeWorkbuddyPayload normalizes tool_choice none by removing tools", () => {
  const payload = {
    messages: [{ role: "user", content: "hi" }],
    tool_choice: { type: "none" },
    tools: [{ type: "function", function: { name: "t" } }]
  };
  const clean = sanitizeWorkbuddyPayload(payload);
  assert.equal(clean.tool_choice, undefined);
  assert.equal(clean.tools, undefined);
  assert.equal(clean.messages[0].role, "system");
});

