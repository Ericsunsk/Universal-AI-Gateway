// 结构化日志模块
// 提供统一的日志格式与 trace_id 追踪能力

/**
 * 生成随机 trace_id（16 字节十六进制）
 * @returns {string}
 */
export function generateTraceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 从请求头提取或生成 trace_id
 * 优先级：X-Trace-Id > X-Request-Id > 生成新 ID
 *
 * @param {Request} request - 请求对象
 * @returns {string}
 */
export function extractTraceId(request) {
  return (
    request.headers.get("x-trace-id") ||
    request.headers.get("x-request-id") ||
    generateTraceId()
  );
}

/**
 * 结构化日志级别
 */
export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
};

/**
 * 创建结构化日志器
 *
 * @param {Object} context - 全局上下文（trace_id, user_id, model 等）
 * @returns {Object} 日志器实例
 */
export function createLogger(context = {}) {
  const minLevel = process.env.LOG_LEVEL
    ? LogLevel[process.env.LOG_LEVEL.toUpperCase()] || LogLevel.INFO
    : LogLevel.INFO;

  function log(level, message, fields = {}) {
    if (level < minLevel) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level: Object.keys(LogLevel).find(k => LogLevel[k] === level),
      message,
      ...context,
      ...fields,
    };

    // 生产环境输出 JSON（便于日志收集系统解析）
    // 开发环境输出人类可读格式
    if (process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json") {
      console.log(JSON.stringify(entry));
    } else {
      const levelName = entry.level.padEnd(5);
      const traceId = entry.trace_id ? `[${entry.trace_id.slice(0, 8)}]` : "";
      const extra = Object.entries(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
      console.log(`${entry.timestamp} ${levelName} ${traceId} ${message}${extra}`);
    }
  }

  return {
    debug: (message, fields) => log(LogLevel.DEBUG, message, fields),
    info: (message, fields) => log(LogLevel.INFO, message, fields),
    warn: (message, fields) => log(LogLevel.WARN, message, fields),
    error: (message, fields) => log(LogLevel.ERROR, message, fields),

    // 创建子日志器（继承父上下文 + 新增字段）
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

/**
 * 脱敏工具：隐藏敏感字段
 *
 * @param {Object} obj - 需要脱敏的对象
 * @param {string[]} sensitiveKeys - 敏感字段名（如 ["token", "password", "apiKey"]）
 * @returns {Object} 脱敏后的对象
 */
export function sanitize(obj, sensitiveKeys = ["token", "password", "apiKey", "secret", "authorization"]) {
  if (!obj || typeof obj !== "object") return obj;

  const result = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    const keyLower = key.toLowerCase();
    const isSensitive = sensitiveKeys.some(k => keyLower.includes(k.toLowerCase()));

    if (isSensitive && typeof value === "string") {
      // 保留前 4 字符 + 星号
      result[key] = value.length > 4 ? `${value.slice(0, 4)}****` : "****";
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitize(value, sensitiveKeys);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * 记录请求日志（入口点）
 *
 * @param {Object} logger - 日志器实例
 * @param {Request} request - 请求对象
 * @param {Object} principal - 认证主体
 * @param {number} startTime - 请求开始时间（ms）
 */
export function logRequest(logger, request, principal, startTime = Date.now()) {
  const url = new URL(request.url);
  logger.info("Request received", {
    method: request.method,
    path: url.pathname,
    user_agent: request.headers.get("user-agent")?.slice(0, 100),
    principal: principal?.role || "anonymous",
    principal_name: principal?.name || null,
  });

  return startTime;
}

/**
 * 记录响应日志（出口点）
 *
 * @param {Object} logger - 日志器实例
 * @param {Request} request - 请求对象
 * @param {Response} response - 响应对象
 * @param {number} startTime - 请求开始时间（ms）
 * @param {Object} meta - 额外元数据（model, provider, tokens 等）
 */
export function logResponse(logger, request, response, startTime, meta = {}) {
  const duration = Date.now() - startTime;
  const url = new URL(request.url);

  const level = response.status >= 500 ? LogLevel.ERROR :
                response.status >= 400 ? LogLevel.WARN :
                LogLevel.INFO;

  const message = response.status >= 400 ? "Request failed" : "Request completed";

  logger[level === LogLevel.ERROR ? "error" : level === LogLevel.WARN ? "warn" : "info"](message, {
    method: request.method,
    path: url.pathname,
    status: response.status,
    duration_ms: duration,
    ...meta,
  });
}
