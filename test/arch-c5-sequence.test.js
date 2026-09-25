import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformAnthropicToOpenAI,
  normalizeOpenAIMessages,
  OpenAIMessageSequence
} from "../src/exchange/exchange.js";

// C5：11148 排序收归 OpenAIMessageSequence 后，fan-out（tool 结果展开 +
// 尾随图片补发）与 re-sort（tool 结果重挂）不再是可单独错序的平级 helper。
// 本文件是唯一的排序测试面：所有断言都经由序列模块（直接 finalize，或
// 经 transformAnthropicToOpenAI 端到端），覆盖此前无单测的交错区间。

const shot = (data, mediaType = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type: mediaType, data }
});
const shotPart = (data, mediaType = "image/png") => ({
  type: "image_url",
  image_url: { url: `data:${mediaType};base64,${data}` }
});

// 上游 11148 序列规则：带 tool_calls 的 assistant 之后必须紧跟其 tool 结果
//（按 tool_calls 顺序），中间不得插入 user/图片消息；游离的 role:tool 非法。
function assertValid11148(messages) {
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (let k = 0; k < m.tool_calls.length; k++) {
        const nxt = messages[i + 1 + k];
        assert.ok(
          nxt && nxt.role === "tool" && nxt.tool_call_id === m.tool_calls[k].id,
          `tool result ${m.tool_calls[k].id} must immediately follow its assistant (index ${i})`
        );
      }
      i += 1 + m.tool_calls.length;
    } else {
      if (m.role === "tool") assert.fail(`orphan tool message at index ${i} breaks 11148`);
      i += 1;
    }
  }
}

test("C5 interleaving: same-message tool_use + companion tool_result + image → 11148 with image last", () => {
  const payload = transformAnthropicToOpenAI({
    model: "m",
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "tu_1", name: "Read", input: { path: "x.png" } },
        { type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "ok" }, shot("aGVsbG8=")] }
      ]
    }]
  }, "m", {});

  assert.deepEqual(payload.messages.map(m => m.role), ["assistant", "tool", "user"]);
  assert.deepEqual(payload.messages[0].tool_calls.map(t => t.id), ["tu_1"]);
  assert.equal(payload.messages[1].tool_call_id, "tu_1");
  assert.equal(payload.messages[1].content, "ok");
  assert.equal(payload.messages[1].content.includes("aGVsbG8="), false, "base64 must not leak into tool text");
  assert.deepEqual(payload.messages[2], { role: "user", content: [shotPart("aGVsbG8=")] });
  assertValid11148(payload.messages);
});

test("C5 interleaving: cross-message tool_result with image trails its exchange", () => {
  const payload = transformAnthropicToOpenAI({
    model: "m",
    messages: [
      { role: "user", content: "read the screenshot" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: ["file text", shot("QUJDRA==", "image/jpeg")] }] }
    ]
  }, "m", {});

  assert.deepEqual(payload.messages.map(m => m.role), ["user", "assistant", "tool", "user"]);
  const toolMsg = payload.messages[2];
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.equal(toolMsg.content, "file text");
  assert.equal(toolMsg.content.includes("QUJDRA=="), false);
  assert.deepEqual(payload.messages[3], { role: "user", content: [shotPart("QUJDRA==", "image/jpeg")] });
  assertValid11148(payload.messages);
});

test("C5 interleaving: consecutive exchanges keep images trailing their own exchange", () => {
  const payload = transformAnthropicToOpenAI({
    model: "m",
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: [{ type: "text", text: "ra" }, shot("QUJD")] }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "g", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "rb" }] }
    ]
  }, "m", {});

  assert.deepEqual(
    payload.messages.map(m => m.role),
    ["assistant", "tool", "user", "assistant", "tool"]
  );
  assert.equal(payload.messages[1].tool_call_id, "a1");
  assert.deepEqual(payload.messages[2], { role: "user", content: [shotPart("QUJD")] });
  assert.equal(payload.messages[4].tool_call_id, "b1");
  assertValid11148(payload.messages);
});

test("C5 byte-stability: image-free payloads serialize identically; finalize ≡ normalize", () => {
  const body = {
    model: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: "plain" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
    ]
  };
  const once = JSON.stringify(transformAnthropicToOpenAI(body, "m", {}));
  const twice = JSON.stringify(transformAnthropicToOpenAI(body, "m", {}));
  assert.equal(once, twice, "image-free output must stay byte-stable");
  // 无图片时 content 保持 string（历史逐字节形状），不切多模态 parts
  assert.deepEqual(transformAnthropicToOpenAI(body, "m", {}).messages[0], { role: "user", content: "plain" });

  const raw = [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "r1" }
  ];
  assert.deepEqual(
    new OpenAIMessageSequence(raw).finalize(),
    normalizeOpenAIMessages(raw),
    "exported normalize and sequence finalize must share one implementation"
  );
});

test("C5 image/text relative order (imageParts index) is preserved", () => {
  const payload = transformAnthropicToOpenAI({
    model: "m",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "image", source: { type: "url", url: "https://example.com/1.png" } },
        { type: "text", text: "b" },
        { type: "image", source: { type: "url", url: "https://example.com/2.png" } }
      ]
    }]
  }, "m", {});
  assert.deepEqual(payload.messages[0].content, [
    { type: "text", text: "a" },
    { type: "image_url", image_url: { url: "https://example.com/1.png" } },
    { type: "text", text: "b" },
    { type: "image_url", image_url: { url: "https://example.com/2.png" } }
  ]);
});

test("C5 seam: out-of-order raw input finalizes to valid 11148 with orphan downgraded", () => {
  const seq = new OpenAIMessageSequence();
  seq.push({ role: "tool", tool_call_id: "early", content: "arrived before assistant" });
  seq.appendToolExchange({
    assistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }]
    },
    toolResultBlocks: [{ type: "tool_result", tool_use_id: "c1", content: "r1" }],
    imageParts: [shotPart("aGVsbG8=")]
  });
  const out = seq.finalize();

  assert.deepEqual(out.map(m => m.role), ["user", "assistant", "tool", "user"]);
  assert.match(out[0].content, /Tool Result/, "early tool result downgraded to user message");
  assert.equal(out[2].tool_call_id, "c1");
  assert.deepEqual(out[3], { role: "user", content: [shotPart("aGVsbG8=")] }, "trailing image stays last");
  assertValid11148(out);
});
