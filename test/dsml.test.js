import test from "node:test";
import assert from "node:assert/strict";
import { containsDsml, parseDsmlInvocations, stripDsml, DsmlStreamParser } from "../src/exchange/dsml.js";

test("containsDsml correctly detects DSML markup variations", () => {
  assert.equal(containsDsml("Hello world"), false);
  assert.equal(containsDsml("1 < 2 && 3 > 2"), false);
  assert.equal(containsDsml("<div>tag</div>"), false);

  assert.equal(containsDsml("<｜｜DSML｜｜ calls>"), true);
  assert.equal(containsDsml("<｜DSML｜tool_calls>"), true);
  assert.equal(containsDsml("<|DSML|invoke name=\"Bash\">"), true);
  assert.equal(containsDsml("<||DSML|| calls>"), true);
});

test("parseDsmlInvocations extracts single and multiple tool calls with full parameters", () => {
  const dsmlText = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="Bash">
<｜｜DSML｜｜ parameter name="command" string="true">cd /path && cat src/exchange/exchange.js</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="description" string="true">Verify exchange facade and its guard test</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
<｜｜DSML｜｜ invoke name="Bash">
<｜｜DSML｜｜ parameter name="command" string="true">grep -n "facade|门面|exchange.js" docs/adr/*.md | head -20</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="description" string="true">Check ADR coverage of facade</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

  const invocations = parseDsmlInvocations(dsmlText);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].name, "Bash");
  assert.equal(invocations[0].args.command, "cd /path && cat src/exchange/exchange.js");
  assert.equal(invocations[0].args.description, "Verify exchange facade and its guard test");
  assert.equal(invocations[1].name, "Bash");
  assert.equal(invocations[1].args.command, "grep -n \"facade|门面|exchange.js\" docs/adr/*.md | head -20");
});

test("parseDsmlInvocations handles string=false with JSON primitives, arrays, and objects", () => {
  const dsmlText = `<｜DSML｜invoke name="Calculator">
<｜DSML｜parameter name="number" string="false">42</｜DSML｜parameter>
<｜DSML｜parameter name="flag" string="false">true</｜DSML｜parameter>
<｜DSML｜parameter name="list" string="false">["apple", "banana"]</｜DSML｜parameter>
<｜DSML｜parameter name="meta" string="false">{"nested": 123}</｜DSML｜parameter>
</｜DSML｜invoke>`;

  const invocations = parseDsmlInvocations(dsmlText);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].name, "Calculator");
  assert.equal(invocations[0].args.number, 42);
  assert.equal(invocations[0].args.flag, true);
  assert.deepEqual(invocations[0].args.list, ["apple", "banana"]);
  assert.deepEqual(invocations[0].args.meta, { nested: 123 });
});

test("stripDsml removes DSML tags and preserves surrounding text", () => {
  const text = `The sub-agent's report is thorough. Let me verify this.

<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="Bash">
<｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>

I will now report the findings.`;

  const clean = stripDsml(text);
  assert.equal(clean, "The sub-agent's report is thorough. Let me verify this.\n\nI will now report the findings.");
});

test("DsmlStreamParser streams text normally when no DSML present", () => {
  const parser = new DsmlStreamParser();
  const chunks = ["Hello, ", "this is ", "a normal ", "message with 1 < 2.", " Enjoy!"];
  const events = [];
  for (const c of chunks) {
    events.push(...parser.push(c));
  }
  events.push(...parser.flush());

  const texts = events.map(e => e.text).join("");
  assert.equal(texts, "Hello, this is a normal message with 1 < 2. Enjoy!");
  assert.equal(events.every(e => e.type === "text"), true);
});

test("DsmlStreamParser intercepts streamed DSML and outputs tool_use events across split chunks", () => {
  const parser = new DsmlStreamParser();
  const chunks = [
    "I need to check the code.\n\n",
    "<｜｜DS",
    "ML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"Bash\">\n",
    "<｜｜DSML｜｜ parameter name=\"command\" string=\"true\">git status</｜｜DSML｜｜ parameter>\n",
    "</｜｜DSML｜｜ invoke>\n",
    "</｜｜DSML｜｜ calls>\nChecking git..."
  ];

  const events = [];
  for (const c of chunks) {
    events.push(...parser.push(c));
  }
  events.push(...parser.flush());

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "text");
  assert.equal(events[0].text, "I need to check the code.\n\n");

  assert.equal(events[1].type, "tool_use");
  assert.equal(events[1].name, "Bash");
  assert.deepEqual(events[1].args, { command: "git status" });
  assert.match(events[1].id, /^call_/);

  assert.equal(events[2].type, "text");
  assert.equal(events[2].text.trim(), "Checking git...");
});

test("streamOpenAIToAnthropic intercepts leaked DSML and emits Anthropic tool_use SSE events", async () => {
  const { streamOpenAIToAnthropic } = await import("../src/exchange/stream.js");

  const sseBody = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "The sub-agent report is thorough.\n\n<｜｜DS" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"Bash\">\n" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "<｜｜DSML｜｜ parameter name=\"command\" string=\"true\">cat src/exchange/exchange.js</｜｜DSML｜｜ parameter>\n" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n"
  ].join("");

  const mockUpstreamResponse = new Response(sseBody, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });

  const anthropicRes = streamOpenAIToAnthropic(mockUpstreamResponse, "claude-3-7-sonnet-20250219", null, {}, {});
  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  let fullOutput = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fullOutput += decoder.decode(value, { stream: true });
  }

  // 验证正文部分被正确下发
  assert.ok(fullOutput.includes('"text":"The sub-agent report is thorough.\\n\\n"'));
  // 验证 DSML 被转译为标准的 Anthropic tool_use 块
  assert.ok(fullOutput.includes('"type":"tool_use"'));
  assert.ok(fullOutput.includes('"name":"Bash"'));
  assert.ok(fullOutput.includes('cat src/exchange/exchange.js'));
  // 验证 stop_reason 被设置为 tool_use
  assert.ok(fullOutput.includes('"stop_reason":"tool_use"'));
  // 验证没有泄漏任何原始 DSML 标记
  assert.ok(!fullOutput.includes("<｜｜DSML｜｜"));
});

test("formatOpenAIToAnthropicJson intercepts leaked DSML and populates tool_use blocks", async () => {
  const { formatOpenAIToAnthropicJson } = await import("../src/exchange/stream.js");

  const jsonBody = JSON.stringify({
    choices: [{
      message: {
        content: 'Let me check files.\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="Bash">\n<｜｜DSML｜｜ parameter name="command" string="true">ls -la</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
      },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 10, completion_tokens: 25 }
  });

  const mockUpstreamResponse = new Response(jsonBody, {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  const anthropicRes = await formatOpenAIToAnthropicJson(mockUpstreamResponse, "claude-3-7-sonnet-20250219", {}, {});
  const data = await anthropicRes.json();

  assert.equal(data.stop_reason, "tool_use");
  const toolBlock = data.content.find(b => b.type === "tool_use");
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, "Bash");
  assert.deepEqual(toolBlock.input, { command: "ls -la" });

  const textBlock = data.content.find(b => b.type === "text");
  assert.ok(textBlock);
  assert.equal(textBlock.text.trim(), "Let me check files.");
  assert.ok(!textBlock.text.includes("DSML"));
});


