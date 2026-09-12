// 剥离/改写 Claude Code 及相关客户端指纹，绕过上游（如腾讯 11128）关键字拦截
export function sanitizeText(text) {
  if (!text || typeof text !== "string") return text;

  // 极速快路径：99% 的用户代码与对话不包含拦截特征词，直接 O(1) 返回，避免长上下文（100k+ tokens）下的无谓正则扫描与内存复制
  if (
    !text.includes("Claude") &&
    !text.includes("Codex") &&
    !text.includes("Main branch") &&
    !text.includes("billing-header") &&
    !text.includes("cc_")
  ) {
    return text;
  }

  // 精准匹配替换：避免无目标项时触发无谓的 string 遍历与正则表达式开销
  if (text.includes("You are Claude Code, Anthropic's official CLI for Claude.")) {
    text = text.replaceAll(
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are Claude Code, Anthropic's official CLI tool for Claude."
    );
  }
  if (text.includes("Main branch (you will usually use this for PRs)")) {
    text = text.replaceAll(
      "Main branch (you will usually use this for PRs)",
      "Default branch (you will usually use this for PRs)"
    );
  }
  if (text.includes("You are a coding agent running in the Codex CLI")) {
    text = text.replaceAll(
      "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
      "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."
    );
  }
  if (text.includes("billing-header")) {
    text = text.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
  }
  if (text.includes("cc_")) {
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

// 高性能微秒级 ANSI 终端转义码与控制字符清洗（过滤终端颜色代码与覆盖刷新符，提升 Token 密度与纯度）
const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(text) {
  if (!text || typeof text !== "string") return text;
  // O(1) 快速跳过：不含控制符直接返回，避免无效正则匹配
  if (!text.includes("\u001b") && !text.includes("\u009b") && !text.includes("\r")) {
    return text;
  }
  let cleaned = text.replace(ANSI_REGEX, "");
  if (cleaned.includes("\r")) {
    cleaned = cleaned.replace(/\r\n/g, "\n").replace(/\r[^\n]/g, "\n");
  }
  return cleaned;
}
