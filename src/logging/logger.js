// 结构化日志模块
// 提供统一的日志格式与 trace_id 追踪能力
import { AsyncLocalStorage } from "node:async_hooks";

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
 * 从请求头提取 trace_id（不生成）
 * 优先级：X-Trace-Id > X-Request-Id > null（由调用方决定是否生成）
 *
 * @param {Request} request - 请求对象
 * @returns {string|null}
 */
export function extractTraceId(request) {
  return (
    request.headers.get("x-trace-id") ||
    request.headers.get("x-request-id") ||
    null
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
// 日志汇聚点：唯一写出通道。测试可经 setLogSink 注入收集器观察日志，
// 无需 monkey-patch console（曾因此让子进程测试的 stdout JSON 被日志污染）。
let sink = (line) => process.stdout.write(line + "\n");

/**
 * 替换日志写出通道（仅测试使用）。传入 null 恢复默认 stdout。
 * @param {Function|null} fn - 接收一行字符串
 */
export function setLogSink(fn) {
  sink = fn || ((line) => process.stdout.write(line + "\n"));
}

export function createLogger(context = {}) {
  function log(level, message, fields = {}) {
    // 级别在**发射时**解析，而非创建时：root logger 于模块加载即建立，
    // 若在创建时固化，之后设置 DEBUG/LOG_LEVEL 将永久失效。
    if (level < resolveMinLevel()) return;

    // 纵深脱敏：直接持 logger 实例调用同样脱敏，不依赖外层 `log` 包装器。
    const safeFields = fields && typeof fields === "object" ? sanitize(fields) : fields;
    const entry = {
      timestamp: new Date().toISOString(),
      level: Object.keys(LogLevel).find(k => LogLevel[k] === level),
      message,
      ...context,
      ...safeFields,
    };

    // 生产环境输出 JSON（便于日志收集系统解析）
    // 开发环境输出人类可读格式
    if (process.env.NODE_ENV === "production" || process.env.LOG_FORMAT === "json") {
      sink(JSON.stringify(entry));
    } else {
      const levelName = entry.level.padEnd(5);
      const traceId = entry.trace_id ? `[${entry.trace_id.slice(0, 8)}]` : "";
      const extra = safeFields && Object.entries(safeFields).length > 0 ? ` ${JSON.stringify(safeFields)}` : "";
      sink(`${entry.timestamp} ${levelName} ${traceId} ${message}${extra}`);
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

// DEBUG=1/true 时降到 DEBUG 级；显式 LOG_LEVEL 优先。
function resolveMinLevel() {
  if (process.env.LOG_LEVEL) {
    return LogLevel[process.env.LOG_LEVEL.toUpperCase()] || LogLevel.INFO;
  }
  const d = String(process.env.DEBUG || "").toLowerCase();
  if (d === "1" || d === "true" || d === "*") return LogLevel.DEBUG;
  return LogLevel.INFO;
}

// 请求作用域日志：一次 runWithLogger() 之后，任意深度都可直接 log.info(...)，
// 无需把 logger 作为参数逐层穿透（providers / core / kv 的工具函数签名保持干净）。
// 异步上下文由 AsyncLocalStorage 自动跨 await / stream 传播。
const als = new AsyncLocalStorage();

// 未进入请求作用域时的兜底（如 server.js 启动日志、定时任务）：无 trace_id 的裸日志器。
const rootLogger = createLogger({});

/**
 * 在请求作用域内运行 fn，期间 log.* 自动带上 trace_id 等上下文。
 * @param {Object} context - { trace_id, ... }
 * @param {Function} fn - 被包裹的处理函数
 */
export function runWithLogger(context, fn) {
  return als.run({ ...context, logger: createLogger(context) }, fn);
}

/**
 * 当前作用域的日志器；不在作用域内时返回 root logger（不会抛错）。
 */
export function currentLogger() {
  return als.getStore()?.logger || rootLogger;
}

/**
 * 深度无关的日志入口：任意模块 import 后直接调用，无需持有 logger 实例。
 * 脱敏的唯一位置是 createLogger 内部（直持实例调用同样覆盖），此处不再预处理。
 */
export const log = {
  debug: (message, fields) => currentLogger().debug(message, fields),
  info: (message, fields) => currentLogger().info(message, fields),
  warn: (message, fields) => currentLogger().warn(message, fields),
  error: (message, fields) => currentLogger().error(message, fields),
};

/**
 * 脱敏工具：隐藏敏感字段
 *
 * 键名归一化后匹配（去 `_-`、小写）：`api_key`/`x-api-key`/`apiKey` 统一为 `apikey`，
 * 避免蛇形/串形漏网。`key` 仅精确匹配（`monkey` 不得误杀）；其余长片段用包含匹配。
 *
 * @param {Object} obj - 需要脱敏的对象
 * @param {string[]} sensitiveKeys - 敏感字段名（归一化后匹配）
 * @returns {Object} 脱敏后的对象
 */
export function sanitize(obj, sensitiveKeys = ["token", "password", "apikey", "secret", "authorization", "credential"]) {
  if (!obj || typeof obj !== "object") return obj;

  const norm = (s) => String(s).toLowerCase().replace(/[_-]/g, "");
  const normKeys = sensitiveKeys.map(norm);

  const result = Array.isArray(obj) ? [] : {};

  for (const [key, value] of Object.entries(obj)) {
    const nk = norm(key);
    const isSensitive = normKeys.some(k => {
      if (k === "key") return nk === "key";
      return nk.includes(k);
    }) || nk === "key";

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
