import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAdminRequest } from "../src/admin/admin.js";

const masterAuth = { ok: true, principal: { isMaster: true, role: "admin" } };

function fakeKv(store) {
  return {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
    delete: async (k) => { store.delete(k); }
  };
}

const post = (body) => new Request("https://x/admin/api/config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

const goodConfig = {
  providers: [{ id: "wb", config: { accounts: [{ id: "a", accessToken: "OLD" }] } }],
  routes: { m: [{ provider: "wb" }] }
};

test("POST /admin/api/config saves valid config (single validate inside saveConfig)", async () => {
  const env = { GATEWAY_KV: fakeKv(new Map()) };
  const res = await handleAdminRequest(post(goodConfig), env, masterAuth, null);
  assert.equal(res.status, 200);
});

test("POST /admin/api/config maps merged-validation failure to 400", async () => {
  const env = { GATEWAY_KV: fakeKv(new Map()) };
  const res = await handleAdminRequest(post({ providers: [], routes: { m: [] } }), env, masterAuth, null);
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.ok(json.error.message.includes("Invalid config"));
});

test("POST /admin/api/config maps version conflict to 409 (was swallowed as 500)", async () => {
  const store = new Map();
  const env = { GATEWAY_KV: fakeKv(store) };
  const first = await handleAdminRequest(post(goodConfig), env, masterAuth, null);
  assert.equal(first.status, 200);
  const stored = JSON.parse(store.get("GATEWAY_CONFIG"));
  const stale = { ...goodConfig, config_version: stored.config_version - 1 };
  const res = await handleAdminRequest(post(stale), env, masterAuth, null);
  assert.equal(res.status, 409);
});
