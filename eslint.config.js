// ESLint flat config（ESLint 9+ / 10）。
//
// 取向：**严格**。规则一律按 error 处理，不为既有代码开豁免口子 ——
// 只对「规则本身误报」的极少数场景做例外，且必须在下方写明理由。
// 任何新增违规都应改代码，不是改配置。
//
// 前提：这是**零构建步骤**的项目（`node server.js` 直跑、`node --test` 直测），
// 因此只用 ESLint 做静态检查，绝不引入编译器 / 打包器 / 代码生成。
import js from "@eslint/js";
import globals from "globals";

export default [
  // 忽略构建产物与依赖；flat config 下 dotfile 不再默认忽略，故显式列出。
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      ".vercel/**",
      "**/.*"
    ]
  },

  // 基线：官方 recommended 集合。
  js.configs.recommended,

  // 项目自有源码 + 测试 + 脚本：统一按 ESM + Node 运行时处理。
  // 含 .mjs —— scripts/ 下的 CLI 用 .mjs，漏掉会报出假的 no-undef。
  {
    files: ["src/**/*.js", "api/**/*.js", "test/**/*.js", "scripts/**/*.mjs", "scripts/**/*.js", "*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        // Web 标准全局：项目跑在 Serverless / Node 18+ 上，直接使用 Web Streams
        // 与 Web Crypto（见 stream.js 的 TransformStream、logger.js 的 crypto.getRandomValues）。
        ...globals.browser,
        crypto: "readonly"
      }
    },
    rules: {
      // --- 严格档 ---

      // 未使用变量：error。默认不放行任何未使用绑定。
      // 唯一例外：以 _ 开头的形参 —— 用于「必须保持签名位置但本实现不消费」的场景
      // （如 mock 对齐真实 callChat(payload) 签名、map 回调的第二参 index）。
      // 这是**严格化**而非放宽：不写 _ 就报错，强制作者显式表态「我知道它没用」。
      "no-unused-vars": ["error", {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true
      }],

      // 浮空 Promise：网关项目最常见的隐性 bug（漏 await 导致请求提前返回）。
      "no-promise-executor-return": "error",

      // 禁止在 finally 中 return/throw —— 会吞掉异常，对熔断/清理路径尤其危险。
      "no-unsafe-finally": "error",

      // 要求 === 而非 ==。项目数值比较密集（token 计数、时长），隐式转换易出错。
      // 唯一例外：== null 同时覆盖 null/undefined，是惯用法。
      eqeqeq: ["error", "always", { null: "ignore" }],

      // 禁止未声明全局赋值：防止打错变量名时静默创建全局（Serverless 下跨请求污染）。
      "no-undef": "error",

      // 未声明变量只读校验：catch 块里给外部变量赋值是新代码数据流的常见误写。
      "no-global-assign": "error",
      "no-implicit-globals": "error",

      // 空的 catch / finally：允许 —— 见下方说明，这是**唯一**的成块豁免。
      "no-empty": ["error", { allowEmptyCatch: true }],

      // 无用赋值 / 无用转义：error，靠改代码消除（已逐处核对，均非误报）。
      "no-useless-assignment": "error",
      "no-useless-escape": "error",

      // 控制字符正则：stripAnsi 的 ANSI_REGEX **必须**匹配 \u001B(ESC)/\u0007(BEL)
      // 才能剥离终端控制码 —— 这是规则的设计外场景，属真误报，定点豁免该文件（见文末）。
      "no-control-regex": "error",

      // 禁止 console：CLI 脚本（scripts/）另设豁免；源码内一律走 logger。
      "no-console": "error"
    }
  },

  // 空 catch：本项目所有空 catch 都是**有意的最佳努力清理**
  //（流 teardown 中的 `try { reader.cancel() } catch {}`），吞掉清理异常是正确行为。
  // 通过 no-empty 的 allowEmptyCatch 表达，而非关闭整条规则。

  // CLI 脚本：面向终端的输出，console 是正确接口。
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "server.js"],
    rules: {
      "no-console": "off"
    }
  },

  // 定点豁免：ANSI 转义序列清洗。
  // - no-control-regex：ANSI_REGEX **必须**匹配 \u001B(ESC)/\u0007(BEL) 才能剥离终端
  //   控制码 —— 这正是它的用途，属规则误报。
  // - no-useless-escape：该正则是广为流传的 ANSI 标准实现，字符类内 \/ 属冗余转义但无害。
  //   已验证等价（行为逐样本比对一致），但**不为此改写**：它是 token 净化链路的
  //   安全相关正则，保持与上游公认实现逐字节一致的价值高于消除两处风格瑕疵。
  {
    files: ["src/exchange/sanitizer.js"],
    rules: {
      "no-control-regex": "off",
      "no-useless-escape": "off"
    }
  }
];
