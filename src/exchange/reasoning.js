/**
 * Universal AI Gateway - Shared Reasoning Normalizer
 * 跨协议、跨大模型厂商的统一思维链与推理强度调度器
 */

const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const DISABLE_KEYWORDS = ["off", "nothink", "none", "disabled", "disable", "false"];

// 档位 ↔ budget 的唯一真值表。
//
// 两函数此前各自硬编码分界与代表值，互不印证：budgetToEffortLevel(4096) === "low"，
// 而 effortLevelToBudget("medium") === 4096 —— 注释却称二者互逆，测试自身也自相矛盾
// （同一文件里 4096 既属 low 又是 medium 的代表值）。
//
// 修复取**保持既有 budget 不变**的一侧：代表值沿用旧表（low=2048/medium=4096/high=12000），
// 仅调整**分界**使其与代表值自洽。这样 effortLevelToBudget 的输出对现有调用方零变化
// （applyReasoningToPayload 在未显式给 budget 时取此值），只修正档位归属的判定边界。
// 各代表值取其区间上界，保证往返恒等。
const LEVEL_BANDS = [
  { level: "minimal", max: 1024 },
  { level: "low", max: 2048 },
  { level: "medium", max: 4096 },
  { level: "high", max: 12000 },
  { level: "xhigh", max: 32000 },
  { level: "max", max: Infinity }
];

/**
 * 从 token budget 转换为标准推理档位
 */
export function budgetToEffortLevel(budgetTokens) {
  const b = Number(budgetTokens) || 0;
  if (b <= 0) return null;
  for (const { level, max } of LEVEL_BANDS) {
    if (b <= max) return level;
  }
  return "max";
}

/**
 * 从标准推理档位转换为推荐的 token budget (Anthropic 规范)
 *
 * 取所在档位的**上界**：既落在本档位内（保证 budgetToEffortLevel 反演回同一档位），
 * 又给足该档位的预算，不因取区间中点而被误判为更低档。
 *
 * 注：`max` 是无上界档位（max: Infinity），只能用 32000 作有限代表，故
 * max → 32000 → xhigh 是**有意为之**的收敛（无上界档位无法用有限 budget 表达），
 * 其余 5 个档位均严格幂等。
 */
export function effortLevelToBudget(level) {
  const key = typeof level === "string" ? level.toLowerCase() : "";
  const band = LEVEL_BANDS.find(b => b.level === key);
  // 未知/缺省档位回退到 medium 的上界（与旧行为一致：未知 → 4096）
  if (!band) return 4096;
  return Number.isFinite(band.max) ? band.max : 32000;
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
 * providerType 即上游的**推理方言**（取值以 core/contract.js REASONING_DIALECTS
 * 为准，此处 switch 的三个分支须与之同义；加方言时两处同改）。
 * 旧第 4 参 targetModel 已删除（全程未用过的定位参数，不保留兼容位）。
 */
export function applyReasoningToPayload(payload, intent, providerType) {
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
  // 3. WorkBuddy / 腾讯云 (支持标准 reasoning_effort: low, medium, high)
  // ----------------------------------------------------
  if (type === "workbuddy") {
    if (intent.enabled && intent.level) {
      let wbEffort = "medium";
      if (intent.level === "minimal" || intent.level === "low") wbEffort = "low";
      else if (intent.level === "high" || intent.level === "xhigh" || intent.level === "max") wbEffort = "high";
      payload.reasoning_effort = wbEffort;
    } else {
      delete payload.reasoning_effort;
    }
    // 严格清洗掉非标准对象结构（thinking/reasoning 对象会导致 400 parameter invalid）
    delete payload.reasoning;
    delete payload.thinking;
    return payload;
  }

  return payload;
}
