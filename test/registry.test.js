import { test } from "node:test";
import assert from "node:assert/strict";
import { registerProvider, supportedProviderTypes, createProvider } from "../src/providers/index.js";

test("registry ships the three built-in provider types", () => {
  assert.deepEqual(supportedProviderTypes(), ["workbuddy", "openai", "anthropic"]);
});

test("registry creates providers without touching the factory", () => {
  class FakeProvider {
    constructor(config) { this.id = config.id; this.type = "fake"; }
  }
  registerProvider("fake-test-type", FakeProvider);
  const instance = createProvider({ id: "f1", type: "fake-test-type" }, {});
  assert.ok(instance instanceof FakeProvider);
  assert.equal(instance.id, "f1");
});

test("registry rejects duplicate registration of a different constructor", () => {
  class A {}
  class B {}
  registerProvider("dup-test-type", A);
  assert.throws(() => registerProvider("dup-test-type", B), /already registered/);
  // 同一构造器重复注册幂等通过
  assert.doesNotThrow(() => registerProvider("dup-test-type", A));
});

test("registry error lists supported types for unknown provider", () => {
  assert.throws(
    () => createProvider({ type: "nope" }, {}),
    (err) => err.message.includes('Unknown provider type "nope"') &&
             err.message.includes("workbuddy")
  );
  assert.equal(createProvider(null, {}), null);
});
