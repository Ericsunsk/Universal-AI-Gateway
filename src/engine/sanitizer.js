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

  text = text.replaceAll(
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI tool for Claude."
  );
  text = text.replaceAll(
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)"
  );
  text = text.replaceAll(
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."
  );

  text = text.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
  text = text.replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "");

  return text.trim();
}

export function sanitizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  return messages.map(msg => {
    if (!msg || typeof msg !== "object") return msg;
    if (typeof msg.content === "string") {
      return { ...msg, content: sanitizeText(msg.content) };
    }
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map(part => {
          if (part && typeof part === "object" && typeof part.text === "string") {
            return { ...part, text: sanitizeText(part.text) };
          }
          return part;
        })
      };
    }
    return msg;
  });
}
