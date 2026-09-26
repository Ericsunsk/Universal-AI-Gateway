import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordCacheControl,
  getCacheControlStats,
  resetCacheControlStats
} from "../src/exchange/cacheControlStats.js";

// #12：cache_control 断点观测。只测量，不改变请求行为。

test("counts breakpoints across system / tools / messages layers", () => {
  resetCacheControlStats();
  recordCacheControl({
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "a", input_schema: {} },
      { name: "b", input_schema: {}, cache_control: { type: "ephemeral" } }
    ],
    messages: [{
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]
    }]
  });
  const s = getCacheControlStats();
  assert.equal(s.totalRequests, 1);
  assert.equal(s.requestsWithBreakpoints, 1);
  assert.equal(s.breakpoints, 3);
  assert.equal(s.byLayer.system, 1);
  assert.equal(s.byLayer.tools, 1);
  assert.equal(s.byLayer.messages, 1);
  assert.equal(s.byLayer.tool_result, 0);
  assert.equal(s.rate, 1);
});

test("counts breakpoints nested inside tool_result content", () => {
  resetCacheControlStats();
  recordCacheControl({
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "text", text: "out", cache_control: { type: "ephemeral" } }]
      }]
    }]
  });
  const s = getCacheControlStats();
  assert.equal(s.byLayer.tool_result, 1);
  assert.equal(s.byLayer.messages, 0);
});

test("counts breakpoints directly on tool_result block", () => {
  resetCacheControlStats();
  recordCacheControl({
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: "direct string output",
        cache_control: { type: "ephemeral" }
      }]
    }]
  });
  const s = getCacheControlStats();
  assert.equal(s.byLayer.tool_result, 1);
  assert.equal(s.byLayer.messages, 0);
});

test("requests without breakpoints still count toward the denominator", () => {
  resetCacheControlStats();
  recordCacheControl({ messages: [{ role: "user", content: "plain string" }] });
  recordCacheControl({
    messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }]
  });
  const s = getCacheControlStats();
  assert.equal(s.totalRequests, 2);
  assert.equal(s.requestsWithBreakpoints, 1);
  assert.equal(s.rate, 0.5);
});

test("empty sample yields rate 0, never NaN", () => {
  resetCacheControlStats();
  assert.equal(getCacheControlStats().rate, 0);
});

test("observation never throws on malformed input", () => {
  resetCacheControlStats();
  assert.doesNotThrow(() => recordCacheControl(null));
  assert.doesNotThrow(() => recordCacheControl("not an object"));
  assert.doesNotThrow(() => recordCacheControl({ messages: "not an array", tools: 42 }));
  assert.doesNotThrow(() => recordCacheControl({ messages: [null, { content: null }] }));
});
