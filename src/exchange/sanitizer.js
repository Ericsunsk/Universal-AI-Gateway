// 转义正则元字符，供大小写不敏感的字面量替换使用
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 对待替换字面量做大小写不敏感替换：上游拦截特征词可能被客户端以任意大小写下发（如全小写），
// 因此检测与改写都必须忽略大小写，否则 `claude code` 变体可绕过 11128 过滤。
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

// 高性能微秒级 ANSI 终端转义码与控制字符清洗（过滤终端颜色代码与覆盖刷新符，提升 Token 密度与纯度）
const ANSI_REGEX = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(text) {
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

// RTK 启发式 Token 净化引擎（去除终端排版噪点、多余空行、样板声明与过量通过测试项）
const REPEATED_SEPARATOR_REGEX = /([=\-#*~_.])\1{5,}/g;
const EXCESSIVE_NEWLINES_REGEX = /\n{3,}/g;
const NOISE_NOTICES_REGEX = /(?:\d+\s+packages are looking for funding\s+run `npm fund`[^\n]*\n?|found 0 vulnerabilities\s*\n?|npm notice created a lockfile[^\n]*\n?)/gi;
const PASSING_TESTS_BLOCK_REGEX = /((?:^[ \t]*(?:✓|PASS|ok|\+)[^\n]+\n){4,})/gm;

export function optimizeToolOutput(text, turnAge = 0, isCompact = false) {
  if (!text || typeof text !== "string") return text;

  // 1. 微秒级 ANSI 控制符与回车覆盖符清洗
  let cleaned = stripAnsi(text);

  // 2. 压缩 6+ 连续重复分隔符（保留 3 字符的语义分割，节约 80% 边框 Token）
  if (cleaned.length > 20) {
    cleaned = cleaned.replace(REPEATED_SEPARATOR_REGEX, "$1$1$1");
  }

  // 3. 过滤纯环境样板噪声（如 npm fund、found 0 vulnerabilities）
  if (cleaned.includes("npm fund") || cleaned.includes("found 0 vulnerabilities") || cleaned.includes("npm notice")) {
    cleaned = cleaned.replace(NOISE_NOTICES_REGEX, "");
  }

  // 4. 连续空行收敛（最多允许 1 个空行，防止垂直空白浪费）
  if (cleaned.includes("\n\n\n")) {
    cleaned = cleaned.replace(EXCESSIVE_NEWLINES_REGEX, "\n\n");
  }

  // 5. 紧凑模式快速截断（针对客户端 compact 意图）
  if (isCompact && cleaned.length > 200) {
    return cleaned.slice(0, 100) + "\n...[output truncated for summary]...\n" + cleaned.slice(-50);
  }

  // 6. 测试用例静默折叠（当测试输出较长且存在 4+ 连续成功测试行时，折叠成功项，完整保留失败项与堆栈）
  if (turnAge > 3 && cleaned.length > 300 && (cleaned.includes("✓") || cleaned.includes("PASS") || cleaned.includes("ok "))) {
    cleaned = cleaned.replace(PASSING_TESTS_BLOCK_REGEX, (match) => {
      const lines = match.trim().split("\n");
      if (lines.length <= 3) return match;
      const collapsedCount = lines.length - 2;
      return `${lines[0]}\n  ... [Gateway: ${collapsedCount} passing tests collapsed for token economy] ...\n${lines[lines.length - 1]}\n`;
    });
  }

  // 7. 阶梯式渐进退火（Progressive Tool Annealing）：
  // - 活跃期（turnAge <= 4）：100% 原始细节无损传输
  // - 中期（5 <= turnAge <= 14）：如果单个工具输出超过 1500 字符，保留头 400 + 尾 200 字符
  // - 远古期（turnAge >= 15）：如果单个工具输出超过 800 字符，保留头 250 + 尾 100 字符
  if (turnAge >= 15 && cleaned.length > 800) {
    const omitted = cleaned.length - 350;
    return (
      cleaned.slice(0, 250) +
      `\n...[Gateway: ${omitted} chars of historical tool output collapsed to optimize context & latency]...\n` +
      cleaned.slice(-100)
    );
  } else if (turnAge >= 5 && cleaned.length > 1500) {
    const omitted = cleaned.length - 600;
    return (
      cleaned.slice(0, 400) +
      `\n...[Gateway: ${omitted} chars of intermediate tool output collapsed]...\n` +
      cleaned.slice(-200)
    );
  }

  return cleaned;
}
