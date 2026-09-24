// WorkBuddy 指纹脱敏 —— 腾讯上游专属（11128 敏感指令拦截），非通用协议翻译。
// 曾在 src/exchange/sanitizer.js，由 provider 越层引用；下沉至此后 provider 只依赖自身目录，
// exchange 只保留厂商无关的通用输出修剪（optimizeToolOutput）。
// 对待替换字面量做大小写不敏感替换：上游拦截特征词可能被客户端以任意大小写下发（如全小写），
// 因此检测与改写都必须忽略大小写，否则 `claude code` 变体可绕过 11128 过滤。
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceAllInsensitive(text, needle, replacement) {
  return text.replace(new RegExp(escapeRegExp(needle), "gi"), replacement);
}

// 快路径门控：大小写不敏感扫描但零分配（regex test 不拷贝整串）；
// 只有命中才做一次 toLowerCase 精确判定，避免 99% benign 长上下文每次都分配小写副本。
const FAST_GATE = /claude|codex|main branch|billing-header|cc_/i;

// 剥离/改写 Claude Code 及相关客户端指纹，绕过上游（如腾讯 11128）关键字拦截
function sanitizeText(text) {
  if (!text || typeof text !== "string") return text;

  // 极速快路径：99% 的用户代码与对话不包含拦截特征词，直接返回，避免长上下文（100k+ tokens）下的无谓拷贝与正则扫描
  if (!FAST_GATE.test(text)) return text;

  // 检测统一使用小写副本，保证大小写不敏感的同时仍只计算一次（仅门控命中后才分配）
  const lower = text.toLowerCase();

  // 精准匹配替换：避免无目标项时触发无谓的 string 遍历与正则表达式开销
  if (lower.includes("you are claude code, anthropic's official cli for claude.")) {
    text = replaceAllInsensitive(
      text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are Claude Code, Anthropic's official CLI tool for Claude."
    );
  }
  if (lower.includes("main branch (you will usually use this for prs)")) {
    text = replaceAllInsensitive(
      text,
      "Main branch (you will usually use this for PRs)",
      "Default branch (you will usually use this for PRs)"
    );
  }
  if (lower.includes("you are a coding agent running in the codex cli")) {
    text = replaceAllInsensitive(
      text,
      "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
      "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."
    );
  }
  if (lower.includes("billing-header")) {
    text = text.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
  }
  if (lower.includes("cc_")) {
    text = text.replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "");
  }

  return text;
}

export function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map(msg => {
    if (!msg || typeof msg !== "object") return msg;
    // 快速跳过 tool 与 assistant 消息：
    // - tool：存放终端与构建日志输出（通常达数十KB至数MB），绝不会包含系统提示词或计费头
    // - assistant：由大模型自身生成的内容，也绝不会包含客户端注入的系统提示词或计费头
    if (msg.role === "tool" || msg.role === "assistant") return msg;

    if (typeof msg.content === "string") {
      const sanitized = sanitizeText(msg.content);
      return sanitized === msg.content ? msg : { ...msg, content: sanitized };
    }
    if (Array.isArray(msg.content)) {
      let changed = false;
      const newContent = msg.content.map(part => {
        if (part && typeof part === "object" && typeof part.text === "string") {
          const sanitized = sanitizeText(part.text);
          if (sanitized !== part.text) {
            changed = true;
            return { ...part, text: sanitized };
          }
        }
        return part;
      });
      return changed ? { ...msg, content: newContent } : msg;
    }
    return msg;
  });
}
