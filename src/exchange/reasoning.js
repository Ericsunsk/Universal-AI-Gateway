/**
 * Universal AI Gateway - Shared Reasoning Normalizer
 * 跨协议、跨大模型厂商的统一思维链与推理强度调度器
 */

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const DISABLE_KEYWORDS = ["off", "nothink", "none", "disabled", "disable", "false"];

/**
 * 从 token budget 转换为标准推理档位
 */
export function budgetToEffortLevel(budgetTokens) {
  const b = Number(budgetTokens) || 0;
  if (b <= 0) return null;
  if (b <= 1024) return "minimal";
  if (b <= 4096) return "low";
  if (b <= 8192) return "medium";
  if (b <= 16000) return "high";
  return "xhigh";
}

/**
 * 从标准推理档位转换为推荐的 token budget (Anthropic 规范)
 */
export function effortLevelToBudget(level) {
  switch (level?.toLowerCase()) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "high":
      return 12000;
    case "xhigh":
    case "max":
      return 32000;
    default:
      return 4096;
  }
}

/**
 * 统一解析来自各种协议和客户端的推理意图
 * 支持：
 * 1. 模型名后缀: claude-3-7-sonnet[high], muse-spark-1.3[low], o3-mini[high], ling-3.0[off]
 * 2. Anthropic thinking: { type: "enabled", budget_tokens: 4096 } 或 { type: "disabled" }
 * 3. OpenAI reasoning_effort: "low" | "medium" | "high"
 * 4. 通用 reasoning: { effort: "...", enabled: boolean }
 */
export function parseReasoningIntent({ model = "", body = {} } = {}) {
  let cleanModel = String(model || "").trim();
  let rawSuffix = null;

  // 1. 匹配并提取模型名末尾的方括号后缀，如 [high]、[low]、[off]。
  // 容量后缀（[200k]/[1M]）仅做剥离，不产生 budget 语义。
  // 支持多层叠加（如 model[high][200k]），循环剥离直到无后缀；
  // 最后一个命中的推理档位/关闭词生效。
  const suffixMatch = cleanModel.match(/\[([^[\]]*)\]$/);
  if (suffixMatch) {
    let guard = 0;
    let m = cleanModel.match(/\[([^[\]]*)\]$/);
    while (m && guard++ < 5) {
      const cand = m[1].toLowerCase().trim();
      if (REASONING_LEVELS.includes(cand) || cand === "mid" || DISABLE_KEYWORDS.includes(cand)) {
        rawSuffix = cand;
      }
      cleanModel = cleanModel.replace(/\[[^[\]]*\]$/, "").trim();
      m = cleanModel.match(/\[([^[\]]*)\]$/);
    }
  }

  let enabled = true;
  let level = null;
  let budgetTokens = null;

  // 检查是否包含关闭思维链的指令
  if (rawSuffix && DISABLE_KEYWORDS.includes(rawSuffix)) {
    enabled = false;
    level = "minimal";
  } else if (rawSuffix && (REASONING_LEVELS.includes(rawSuffix) || rawSuffix === "mid")) {
    enabled = true;
    level = rawSuffix === "mid" ? "medium" : rawSuffix;
  }

  // 2. 检查 Anthropic 原生 thinking 配置
  if (body?.thinking) {
    if (body.thinking.type === "disabled") {
      enabled = false;
      level = "minimal";
    } else if (body.thinking.type === "enabled") {
      enabled = true;
      const b = Number(body.thinking.budget_tokens) || 0;
      if (b > 0) {
        budgetTokens = b;
        if (!level) {
          level = budgetToEffortLevel(b);
        }
      }
    }
  }

  // 3. 检查 OpenAI reasoning_effort 参数
  if (body?.reasoning_effort && !level) {
    const effort = String(body.reasoning_effort).toLowerCase().trim();
    if (DISABLE_KEYWORDS.includes(effort)) {
      enabled = false;
    } else if (REASONING_LEVELS.includes(effort)) {
      level = effort;
    }
  }

  // 4. 检查通用 reasoning 结构体
  if (body?.reasoning) {
    if (body.reasoning.enabled === false) {
      enabled = false;
    }
    if (body.reasoning.effort && !level) {
      const effort = String(body.reasoning.effort).toLowerCase().trim();
      if (REASONING_LEVELS.includes(effort)) {
        level = effort;
      }
    }
  }

  // 若开启了思考且有档位，但未显式指定 budgetTokens，自动补全推荐的预算
  if (enabled && level && !budgetTokens) {
    budgetTokens = effortLevelToBudget(level);
  }

  return {
    cleanModel,
    rawSuffix,
    enabled,
    level,
    budgetTokens
  };
}

/**
 * 将解析出的标准推理意图，安全适配注入到对应上游提供商的 Payload 中
 *
 * targetModel 为**保留的定位参数**：签名契约的一部分（8 处调用方 + 测试按位置传入），
 * 见 AGENTS.md「公共 API 顺序不变」。当前按 providerType 分支即可判定注入策略，
 * 尚未用到模型名；保留形参以免破坏既有调用点。签名中保留即为其存在意义，勿删。
 */
export function applyReasoningToPayload(payload, intent, providerType, targetModel = "") {
  void targetModel; // 显式声明显式未用（签名契约保留），非疏漏
  if (!payload || !intent) return payload;

  const type = (providerType || "").toLowerCase();

  // ----------------------------------------------------
  // 1. Anthropic 官方 / 兼容提供商 (如 Claude 3.7 Hybrid Thinking)
  // ----------------------------------------------------
  if (type === "anthropic") {
    if (!intent.enabled) {
      payload.thinking = { type: "disabled" };
    } else if (intent.level || intent.budgetTokens) {
      const budget = Math.max(1024, intent.budgetTokens || effortLevelToBudget(intent.level || "medium"));
      payload.thinking = {
        type: "enabled",
        budget_tokens: budget
      };
      // Anthropic 规范：开启 Extended Thinking 时 temperature 必须为 1.0 或不传
      // Anthropic thinking 要求 temperature=1.0；覆盖时不记录日志（避免生产噪音）
      if (payload.temperature !== undefined && payload.temperature !== 1.0) {
        payload.temperature = 1.0;
      }
    }
    return payload;
  }

  // ----------------------------------------------------
  // 2. OpenAI 官方 / 兼容提供商 (如 o1, o3-mini, DeepSeek 官方)
  // ----------------------------------------------------
  if (type === "openai" || !type) {
    // 映射到 OpenAI 仅支持的 3 档: low, medium, high
    let openaiEffort = "medium";
    if (intent.level === "minimal" || intent.level === "low") openaiEffort = "low";
    else if (intent.level === "high" || intent.level === "xhigh" || intent.level === "max") openaiEffort = "high";

    if (intent.enabled && intent.level) {
      payload.reasoning_effort = openaiEffort;
      payload.reasoning = {
        effort: openaiEffort,
        enabled: true
      };
    } else if (!intent.enabled) {
      delete payload.reasoning_effort;
      payload.reasoning = { enabled: false };
    }
    return payload;
  }

  // ----------------------------------------------------
  // 3. WorkBuddy / 腾讯云 (不支持外部动态调节推理强度的渠道)
  // ----------------------------------------------------
  if (type === "workbuddy") {
    // 严格清洗掉非标准推理参数，防止上游返回 400 parameter invalid 报错
    delete payload.reasoning_effort;
    delete payload.reasoning;
    delete payload.thinking;
    return payload;
  }

  return payload;
}
