// Qwen 网页版（chat.qwen.ai）协议纯函数 —— 抓包实测形状为准。
// 流程：POST /api/v2/chats/new 取 chat_id → POST /api/v2/chat/completions?chat_id= 流式增量，
// 多轮靠 parentId = 上一轮 response_id 链式。鉴权走 cookie + 指纹头（见 fingerprint.js），
// completions 请求体本身不带 Authorization。
// SSE 事件形态按 qwen-reverse 文档 + 实测做宽容多态解析，live 验证后收紧。

export const QWENWEB_DEFAULT_BASE_URL = "https://chat.qwen.ai";
export const QWENWEB_API_VERSION = "2.1";

export function newUuid(random = Math.random) {
  const hex = () => Math.floor(random() * 0xffff).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`.slice(0, 36);
}

// POST /api/v2/chats/new 取 chat_id（兼容 {chat_id} / {data:{chat_id}} / {id} 三种包法）
export function parseChatNew(json) {
  if (!json || typeof json !== "object") return null;
  return json.chat_id || json.data?.chat_id || json.id || json.data?.id || null;
}

// OpenAI 单条消息 → qwen 单轮 turn（多轮由调用方逐轮送，parent 链在 provider 层维护）。
// systemPrefix 只在首轮 user 前拼接一次（调用方负责）；content 非 string 时拍平。
export function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(c => typeof c === "string" ? c : (c.text || "")).join("\n");
  }
  return JSON.stringify(content ?? "");
}

export function buildTurn({ role, content }, model, { systemPrefix = "", fid = null, parentId = null, timestamp = Date.now(), random = Math.random } = {}) {
  const text = (role === "user" && systemPrefix ? systemPrefix + "\n" : "") + flattenContent(content);
  const id = fid || newUuid(random);
  return {
    id: null,
    fid: id,
    parentId,
    childrenIds: [newUuid(random)],
    role: role === "assistant" ? "assistant" : "user",
    content: text,
    user_action: "chat",
    files: [],
    timestamp,
    models: [model],
    model: "",
    chat_type: "t2t",
    feature_config: {
      thinking_enabled: true,
      output_schema: "phase",
      research_mode: "normal",
      auto_thinking: true,
      thinking_mode: "Auto",
      thinking_format: "summary",
      auto_search: true
    },
    extra: { meta: { subChatType: "t2t" } },
    sub_chat_type: "t2t",
    parent_id: parentId
  };
}

// OpenAI messages[] → { systemPrefix, turns:[{role, content}] }（tool/tool_calls 角色直接丢弃，
/// qwen 网页通道无函数调用；要 tools 走其他供应商路由）。
export function splitHistory(messages) {
  const sys = [];
  const turns = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "system") {
      sys.push(flattenContent(m.content));
    } else if (m.role === "user" || m.role === "assistant") {
      turns.push({ role: m.role, content: flattenContent(m.content) });
    }
  }
  return { systemPrefix: sys.join("\n"), turns };
}

// 历史截断规则（T3 决议）：system 全留 + 最近 MAX_TURNS 轮，中部直接丢弃不留 notice
// （notice 会污染前缀；coding 会话 20 轮外的上下文基本无用）。返回新数组，不修改入参。
export const QWENWEB_MAX_TURNS = 20;

export function truncateHistory(systemPrefix, turns, maxTurns = QWENWEB_MAX_TURNS) {
  if (!Array.isArray(turns) || turns.length <= maxTurns) {
    return { systemPrefix: systemPrefix || "", turns: turns || [] };
  }
  return { systemPrefix: systemPrefix || "", turns: turns.slice(turns.length - maxTurns) };
}

// POST /api/v2/chat/completions?chat_id= 请求体（抓包字段全量，缺一可能被风控加权）
export function buildCompletionsBody({ chatId, parentId, model, turn, timestamp = Date.now() }) {
  return {
    stream: true,
    version: QWENWEB_API_VERSION,
    incremental_output: true,
    chatId,
    parentId,
    chat_id: chatId,
    chat_mode: "normal",
    model,
    parent_id: parentId,
    messages: [turn],
    timestamp
  };
}

// WAF / 验证码拦截识别（API 层）：403/302、HTML 回包、已知风控签名。
// 命中 → 网关按 429 冷却漂移（复用现有退避不断链），绝不把挑战页当答案流给客户端。
export function isWAFStatus(status) {
  return status === 403 || status === 302 || status === 429;
}

export function isWAFBody(text = "") {
  const s = String(text || "").slice(0, 2000).toLowerCase();
  return (
    s.includes("aliyun_waf") ||
    s.includes("fail_sys_user_validate") ||
    s.includes("captcha") ||
    s.includes("nc-no-captcha") ||
    s.includes("滑块") ||
    s.includes("真人验证") ||
    s.includes("访问验证") ||
    (s.includes("<html") && s.includes("验证"))
  );
}

// qwen SSE chunk → { kind, text, responseId } 宽容解析。
// kind: reasoning | content | usage | tool_calls | done | notice | unknown
// 顺序是活的（T5 原型验出）：真实形态 choices/delta/phase 优先；usage 附着在数据事件上，
// 绝不能先判 usage 吞掉正文；空 tick（content "" + typing）判 unknown 由调用方跳过。
export function parseQwenSSEObject(obj) {
  if (!obj || typeof obj !== "object") return { kind: "unknown" };
  const responseId = obj.response_id || obj.responseId || obj.id || null;
  if (obj["response.created"]) return { kind: "unknown", responseId: obj["response.created"].response_id || responseId };
  // 真实形态（live 样本）：choices[0].delta.phase ∈ thinking_summary | answer，结束靠 status finished
  const ph = obj.choices?.[0]?.delta;
  if (ph && typeof ph === "object") {
    if (ph.phase === "thinking_summary" || ph.phase === "thinking" || ph.phase === "think") {
      const extra = ph.extra || {};
      const raw = extra.summary_thought?.content ?? extra.thinking?.content ?? null;
      const text = Array.isArray(raw) ? raw.join("") : String(raw ?? ph.content ?? "");
      if (text) return { kind: "reasoning", text, responseId };
      return { kind: "unknown", responseId };
    }
    if (ph.phase === "answer") {
      if (ph.content) return { kind: "content", text: String(ph.content), responseId };
      if (ph.status === "finished") return { kind: "done", responseId };
      return { kind: "unknown", responseId };
    }
  }
  // qwen-reverse 文档形：{type, data} + phase
  const t = obj.type || obj.event;
  if (t === "reasoning" || obj.phase === "think") {
    return { kind: "reasoning", text: String(obj.data ?? obj.content ?? ""), responseId };
  }
  if (t === "content" || obj.phase === "answer") {
    return { kind: "content", text: String(obj.data ?? obj.content ?? obj.text ?? ""), responseId };
  }
  if (t === "usage" || obj.usage) {
    return { kind: "usage", usage: obj.usage || obj.data, responseId };
  }
  if (t === "tool_calls" || obj.tool_calls) {
    return { kind: "tool_calls", toolCalls: obj.tool_calls || obj.data, responseId };
  }
  if (t === "done" || obj.finish === true || obj.done === true || obj.finish_reason) {
    return { kind: "done", responseId, finishReason: obj.finish_reason || null };
  }
  // OpenAI 形透传（部分后端直接回 chat.completion.chunk）
  const delta = obj.choices?.[0]?.delta;
  if (delta && (delta.content || delta.reasoning_content || delta.reasoning)) {
    if (delta.reasoning_content || delta.reasoning) {
      return { kind: "reasoning", text: String(delta.reasoning_content || delta.reasoning), responseId };
    }
    return { kind: "content", text: String(delta.content || ""), responseId };
  }
  if (obj.choices?.[0]?.finish_reason) {
    return { kind: "done", responseId, finishReason: obj.choices[0].finish_reason };
  }
  if (obj.error || obj.code) {
    return { kind: "notice", text: String(obj.error?.message || obj.msg || obj.message || "upstream notice"), responseId };
  }
  return { kind: "unknown", responseId };
}
