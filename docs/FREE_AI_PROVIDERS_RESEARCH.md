# 个人开发者主流免费 AI 大模型供应商一手调研报告
> **调研基准**：严格聚焦 **2024 下半年至 2025/2026 年最新代际前沿模型**（如 DeepSeek-R1 / V3、Claude 3.7 / 3.5 Sonnet、Gemini 2.0 系列、Qwen 2.5 72B / Coder、Llama 3.3 70B、o3-mini / o1、GLM-4-Flash 等），彻底剔除历史旧模型。
> **适配目标**：全面对标并深度融入个人开发者的轻量 AI 网关 `Worker-AI-Gateway`（Cloudflare Workers 架构）的 Provider 调度与 Fallback 容灾机制。

---

## 目录
1. [调研全景总览与对比矩阵](#一调研全景总览与对比矩阵)
2. [第一梯队：官方长效/永久免费 API（高稳定、OpenAI 原生兼容、零维护成本）](#二第一梯队官方长效永久免费-api)
   - 2.1 Google AI Studio (Gemini 2.0 Flash / Pro / Flash-Thinking)
   - 2.2 GitHub Models (o1 / o3-mini / DeepSeek-R1 / GPT-4o)
   - 2.3 智谱 AI 开放平台 BigModel (GLM-4-Flash 永久免费)
   - 2.4 Groq Cloud (LPU 极速推理：DeepSeek-R1-Distill / Llama 3.3)
   - 2.5 OpenRouter (:free 标签模型池)
   - 2.6 硅基流动 SiliconFlow (0元模型池 + 赠金)
   - 2.7 阿里云百炼 Bailian / DashScope (Qwen 2.5 / DeepSeek 巨额体验额度)
   - 2.8 Cloudflare Workers AI (每日 10,000 Neurons 免费配额)
3. [第二梯队：超高速硬件算力免费层（满血开源 SOTA 吞吐极客）](#三第二梯队超高速硬件算力免费层)
   - 3.1 SambaNova Cloud (DeepSeek-R1 满血版 671B / Llama 3.3 70B)
   - 3.2 Cerebras Cloud (Llama 3.3 70B 极速 2100 tps)
4. [第三梯队：客户端/插件反代与每日打卡签到送积分渠道](#四第三梯队客户端插件反代与每日打卡签到送积分渠道)
   - 4.1 腾讯云 AI 代码助手 WorkBuddy / CodeBuddy (当前核心主力)
   - 4.2 字节跳动 Trae IDE & 火山方舟 (Claude 3.7 / GPT-4o 免费红利)
   - 4.3 阿里灵码 Tongyi Lingma (Qwen 2.5 Coder 个人永久免费)
   - 4.4 百度文心快码 Comate & 华为 CodeArts Snap 简析
5. [第四梯队：纯免鉴权 / 免卡聚合与终极保底端点](#五第四梯队纯免鉴权免卡聚合与终极保底端点)
   - 5.1 Pollinations.ai (100% 免注册、免 Key、免卡)
   - 5.2 Hugging Face Serverless Inference API (免信用卡推理)
6. [针对 Worker-AI-Gateway 的落地集成方案与推荐路由配置](#六针对-worker-ai-gateway-的落地集成方案与推荐路由配置)

---

## 一、调研全景总览与对比矩阵

| 供应商名称 | 免费模式 | 最新代际核心可用模型 | 免费配额 / 速率限制 | OpenAI 协议兼容性 | Worker-AI-Gateway 接入友好度 | 风控与稳定性等级 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Google AI Studio** | 官方长效 Free Tier（免绑卡） | Gemini 2.0 Flash, Gemini 2.0 Flash-Thinking, Gemini 2.0 Pro | 15 RPM / 1,500 RPD / 1M TPM | 原生支持 `/v1beta/openai` | ⭐️⭐️⭐️⭐️⭐️ (零改动接入) | 稳健（海外边缘免翻） |
| **GitHub Models** | 官方免费原型层（GitHub 账号直用） | o1, o3-mini, DeepSeek-R1, GPT-4o, Llama 3.3 70B, Phi-4 | 15 RPM / 150 RPD (高端), 1,500 RPD (轻量) | 原生兼容 Azure OpenAI | ⭐️⭐️⭐️⭐️⭐️ (PAT 令牌直接接入) | 极高（微软官方背书） |
| **智谱 AI (BigModel)** | 官方永久免费模型 + 新人赠金 | GLM-4-Flash (永久免费), GLM-4v-Flash, GLM-4-Plus | 默认 5~10 QPS，无单日 Token 硬上限 | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️⭐️ (直连极速) | 极高（国内合规备案） |
| **Groq Cloud** | 开发者 Free Tier（手机验证） | DeepSeek-R1-Distill-70B, Llama-3.3-70B-Versatile | 30 RPM / 1,000 RPD / 100K TPD | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️⭐️ (极速响应链路) | 高（需海外网络请求） |
| **OpenRouter** | `:free` 标签常态化免费 | deepseek-r1:free, deepseek-chat:free, llama-3.3-70b:free, qwen-2.5-coder:free | 20 RPM (充值过 $1 提至 200 RPM), 约 200~500 RPD | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️⭐️ (网关已预置模板) | 中（高峰偶有排队） |
| **硅基流动 (SiliconFlow)** | 0 元模型池 + 新人 14~20 元赠金 | DeepSeek-R1/V3 (赠金), R1-Distill 系列 (0元), Qwen 2.5 系列 | 免费版 5~10 RPM；赠金满血版可调用千万级 Token | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️⭐️ (国内直连低延迟) | 极高（国内知名基建） |
| **阿里云百炼 (Bailian)** | 各模型独立大额免费额度 | Qwen-Max, Qwen-Plus, Qwen2.5-Coder, DeepSeek-R1/V3 | 赠送 100万~2000万 Token/模型，有效期 1~6 个月 | 原生兼容兼容模式端点 | ⭐️⭐️⭐️⭐️⭐️ (国内顶尖算力) | 极高（阿里云 SLA） |
| **Cloudflare Workers AI** | 每日常态化 10,000 Neurons 额度 | DeepSeek-R1-Distill-32B, Llama-3.3-70B, Qwen 2.5 7B | 每日 10,000 Neurons (可支撑日常轻量任务与分类) | 原生内网直调 + 外部兼容端点 | ⭐️⭐️⭐️⭐️⭐️ (同架构内网 0 延迟) | 极高（自家资产） |
| **SambaNova Cloud** | 开发者免费层（SN40L 算力） | DeepSeek-R1 满血版 671B, Llama 3.3 70B, Qwen 2.5 72B | 10~20 RPM, 20~40 RPD | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️ (高吞吐体验) | 高（免费层日额度较紧） |
| **Cerebras Cloud** | 开发者免费层（WSE-3 芯片） | Llama-3.3-70B (超快 2100 tps) | 30 RPM / 60,000 TPM / 1M TPD | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️ (代码补全极速) | 高（需海外网络） |
| **腾讯云 WorkBuddy** | 每日定时签到领积分 + 客户端逆向 | Claude 3.7 / 3.5 Sonnet, DeepSeek-R1/V3, GLM, Kimi | 签到每日 50~100 积分（永动机），对话扣 1~5 分 | 需逆向/网关协议转译 | ⭐️⭐️⭐️⭐️⭐️ (已原生内置转译与脱敏) | 中（需防 11128 与风控） |
| **字节 Trae IDE** | 推广期全免费客户端 | Claude 3.7 Sonnet (Thinking), Claude 3.5 Sonnet, GPT-4o | 个人日常使用近乎无硬上限（限客户端界面） | 私有 RPC 协议 | ⭐️⭐️ (推荐本地 IDE 直接用) | 中（强行逆向封号高） |
| **阿里灵码 (Lingma)** | 个人版永久免费 | Qwen 2.5 Coder 32B/72B 深度优化版 | 个人日常写代码无限制 | 私有协议需本地反代桥接 | ⭐️⭐️⭐️ (需本地 proxy 中转) | 低（个人正常自用安全） |
| **Pollinations.ai** | 纯免鉴权、免 Key、免卡 | DeepSeek-R1, DeepSeek-V3, Llama 3.3 70B, Qwen Coder | 建议 20~30 RPM 内，无日总配额 | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️⭐️ (终极无成本兜底) | 极低风险（无需账号） |
| **Hugging Face Serverless** | 免费 Serverless API（需 HF Token） | DeepSeek-R1-Distill-32B, Llama 3.3 70B, Qwen Coder | 共享限额，冷门模型有冷启动 | 原生兼容 OpenAI 格式 | ⭐️⭐️⭐️⭐️ (冷备方案) | 极高（无封禁风险） |

---

## 二、第一梯队：官方长效/永久免费 API

### 2.1 Google AI Studio (Gemini 2.0 旗舰系列)
- **官方一手主页与文档**：
  - 控制台：[https://aistudio.google.com/](https://aistudio.google.com/)
  - 定价与免费层说明：[https://ai.google.dev/pricing](https://ai.google.dev/pricing)
  - 速率限制文档：[https://ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- **免费模式**：
  - **官方长效免费层 (Free Tier)**：注册并进入 Google AI Studio，点击 "Get API key" 即可直接获取密钥，**无需绑定任何信用卡或银行卡**。
- **最新代际可用模型**：
  - `gemini-2.0-flash`：最新主力多模态高速旗舰，100 万 Token 上下文。
  - `gemini-2.0-flash-thinking-exp-01-21`：具备完整思考链推理能力的最新 SOTA 推理模型，对标 DeepSeek-R1 与 o3-mini。
  - `gemini-2.0-pro-exp-02-05`：前沿编码与复杂通用推理标杆。
  - `gemini-1.5-pro`：200 万 Token 极限长上下文分析。
- **速率与配额限制**：
  - `gemini-2.0-flash`：**15 RPM** (每分钟请求数), **1,000,000 TPM** (每分钟 Token 数), **1,500 RPD** (每天 1,500 次请求)。
  - `gemini-2.0-flash-thinking-exp`：**10 RPM**, **4,000,000 TPM**, **1,500 RPD**。
  - `gemini-2.0-pro-exp`：**5 RPM**, **2,000,000 TPM**, **50 RPD**。
- **Worker-AI-Gateway 接入方式**：
  - Google 官方原生支持 OpenAI SDK 兼容端点：
    - `baseUrl`: `https://generativelanguage.googleapis.com/v1beta/openai`
    - `apiKey`: Google AI Studio 颁发的 `AIzaSy...` 密钥
    - 端点: `/chat/completions`

### 2.2 GitHub Models (微软 Azure 顶级算力体验层)
- **官方一手主页与文档**：
  - 官方入口：[https://github.com/marketplace/models](https://github.com/marketplace/models)
  - 官方文档与配额：[https://docs.github.com/en/github-models/prototyping-with-ai-models](https://docs.github.com/en/github-models/prototyping-with-ai-models)
- **免费模式**：
  - **官方免费原型层 (Free Prototyping Tier)**：只要拥有个人 GitHub 账号，在 GitHub Settings -> Developer settings -> Personal access tokens 中生成 PAT 即可免费调用，无需绑定信用卡。
- **最新代际可用模型**：
  - `DeepSeek-R1`：由 Azure AI 托管部署的 671B 满血版深度思考模型。
  - `o1` & `o3-mini`：OpenAI 最新的顶级深度推理模型（全网唯一无需绑卡免费官方 API 渠道）。
  - `gpt-4o` & `gpt-4o-mini`：OpenAI 最新多模态旗舰。
  - `meta-llama-3.3-70b-instruct`：Meta 旗舰 70B。
  - `Phi-4`：微软最新前沿模型。
- **速率与配额限制**：
  - 高端模型 (o1, o3-mini, DeepSeek-R1, GPT-4o)：**15 RPM**, **150 RPD**。
  - 轻量模型 (GPT-4o-mini, Llama 3.3 70B, Phi-4)：**15 RPM**, **1,500 RPD**。
- **Worker-AI-Gateway 接入方式**：
  - `baseUrl`: `https://models.inference.ai.azure.com`
  - `apiKey`: 你的 GitHub PAT (`ghp_...` 或 `github_pat_...`)

### 2.3 智谱 AI 开放平台 BigModel (GLM-4-Flash 永久免费)
- **官方主页与文档**：[https://bigmodel.cn/](https://bigmodel.cn/) | [https://bigmodel.cn/pricing](https://bigmodel.cn/pricing)
- **免费模式**：官方明确宣布 `glm-4-flash` 与 `glm-4v-flash` **永久 0 元免费调用**。
- **最新代际模型**：`glm-4-flash`（128K 上下文，支持工具调用，响应延迟极低）。
- **配额**：默认并发 5~10 QPS，每日总 Token 无硬性上限。
- **Worker-AI-Gateway 接入方式**：
  - `baseUrl`: `https://open.bigmodel.cn/api/paas/v4`
  - `apiKey`: 智谱 API Key

### 2.4 Groq Cloud (LPU 芯片极速推理)
- **官方主页与文档**：[https://console.groq.com/settings/limits](https://console.groq.com/settings/limits)
- **核心最新模型**：`deepseek-r1-distill-llama-70b` (250~320 tokens/s), `llama-3.3-70b-versatile`。
- **配额**：**30 RPM**, **1,000 RPD**, **100,000 TPD**。
- **Worker-AI-Gateway 接入方式**：
  - `baseUrl`: `https://api.groq.com/openai/v1`
  - `apiKey`: `gsk_...`

### 2.5 OpenRouter (:free 标签模型池)
- **官方主页**：[https://openrouter.ai/models?q=free](https://openrouter.ai/models?q=free)
- **最新核心免费模型**：`deepseek/deepseek-r1:free`, `deepseek/deepseek-chat:free`, `meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen-2.5-coder-32b-instruct:free`, `google/gemini-2.0-flash-thinking-exp:free`。
- **配额**：未付费约 20 RPM、200~500 RPD；曾充值 $1 账号提至 200 RPM 无硬性日限。
- **Worker-AI-Gateway 接入方式**：原生支持，`baseUrl`: `https://openrouter.ai/api/v1`。

### 2.6 硅基流动 SiliconFlow (0 元模型池 + 赠金)
- **官方主页**：[https://siliconflow.cn/](https://siliconflow.cn/)
- **核心模型**：0元免费蒸馏版 `DeepSeek-R1-Distill-Qwen-32B/70B`、`Qwen2.5-Coder-7B`；注册赠金 14~20 元可直接调满血 `DeepSeek-V3/R1`。
- **Gateway 接入**：`https://api.siliconflow.cn/v1`，标准 OpenAI 格式。

### 2.7 阿里云百炼 Bailian / DashScope
- **官方文档**：[https://help.aliyun.com/zh/model-studio/user-guide/free-quota](https://help.aliyun.com/zh/model-studio/user-guide/free-quota)
- **免费模式**：首次开通赠送各模型独立额度（`qwen-max` 100万、`qwen-plus` 1000万、`qwen-turbo` 2000万 Token）。
- **Gateway 接入**：`https://dashscope.aliyuncs.com/compatible-mode/v1`。

### 2.8 Cloudflare Workers AI
- **官方文档**：[https://developers.cloudflare.com/workers-ai/platform/pricing/](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- **配额**：每日 10,000 Neurons 免费推理（UTC 00:00 刷新）。
- **最新模型**：`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, `@cf/meta/llama-3.3-70b-instruct`。
- **Gateway 接入**：在当前 Worker 中直接通过 `env.AI.run()` 零网络延迟内网绑定调用。

---

## 三、第二梯队：超高速硬件算力免费层

### 3.1 SambaNova Cloud (SN40L 算力)
- **官网**：[https://cloud.sambanova.ai/](https://cloud.sambanova.ai/)
- **模型**：`DeepSeek-R1` (满血 671B, 150+ tokens/s), `Llama-3.3-70B`, `Qwen2.5-Coder-32B`。
- **限额**：20 RPM，约 20~40 RPD。
- **端点**：`https://api.sambanova.ai/v1`。

### 3.2 Cerebras Cloud (世界最快推理)
- **官网**：[https://cloud.cerebras.ai/](https://cloud.cerebras.ai/)
- **模型**：`llama-3.3-70b` (超快 2100 tokens/s)。
- **限额**：30 RPM，每日 1,000,000 Tokens 免费额度。
- **端点**：`https://api.cerebras.ai/v1`。

---

## 四、第三梯队：客户端/插件反代与每日打卡渠道

### 4.1 腾讯云 AI 代码助手 WorkBuddy (已集成)
- **模式**：每日 Cron 自动打卡签到送 50~100 积分，通过 HS512 RefreshToken 自动无感保活。
- **最新模型**：`deepseek-v4.1-flash`, `deepseek-v4-pro`, `claude-3-7-sonnet-20250219`, `claude-3-5-sonnet-20241022`, `glm-5.2`, `kimi-k3-1`。
- **现状**：已在当前网关中实现多账号池轮换、定时自动打卡、11128 脱敏与 `/v1/usage` 积分卡片。

### 4.2 字节跳动 Trae IDE
- **模式**：推广红利期，桌面端免费畅用 Claude 3.7 Sonnet (Thinking)、GPT-4o、DeepSeek-R1。因采用私有 RPC 协议且严格校验设备指纹，更适合在本地直接作为主力 IDE 使用。

### 4.3 阿里灵码 (Tongyi Lingma)
- **模式**：个人版永久免费使用 `Qwen 2.5 Coder 32B/72B`，需本地代理桥接，适合作为本地补全备选。

---

## 五、第四梯队：纯免鉴权聚合端点

### 5.1 Pollinations.ai (纯免注册/免 Key 兜底)
- **官网**：[https://pollinations.ai/](https://pollinations.ai/)
- **模型**：`deepseek-r1`, `deepseek` (V3), `llama` (3.3 70B), `qwen-coder`。
- **端点**：`https://text.pollinations.ai/openai`，支持标准 OpenAI 协议，apiKey 填任意字符串。适合作为网关容灾链最后一级的兜底保底。

---

## 六、针对 Worker-AI-Gateway 的落地集成方案与推荐配置

可在网关中通过 `/admin/api/config` 直接配置的多级 Fallback 链路：

```json
{
  "usage_provider_id": "workbuddy",
  "providers": [
    {
      "id": "workbuddy",
      "name": "WorkBuddy (腾讯云代码助手)",
      "type": "workbuddy",
      "enabled": true
    },
    {
      "id": "google_studio",
      "name": "Google AI Studio",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
        "apiKey": "AIzaSy..."
      }
    },
    {
      "id": "github_models",
      "name": "GitHub Models (Azure)",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://models.inference.ai.azure.com",
        "apiKey": "ghp_..."
      }
    },
    {
      "id": "zhipu",
      "name": "智谱 AI (GLM-4-Flash 永久免费)",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
        "apiKey": "..."
      }
    },
    {
      "id": "groq",
      "name": "Groq Cloud (LPU 极速)",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://api.groq.com/openai/v1",
        "apiKey": "gsk_..."
      }
    },
    {
      "id": "openrouter",
      "name": "OpenRouter (Free Tier)",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "apiKey": "sk-or-v1-...",
        "defaultHeaders": {
          "HTTP-Referer": "https://worker-gateway.local",
          "X-Title": "Worker Gateway"
        }
      }
    },
    {
      "id": "pollinations",
      "name": "Pollinations (免鉴权兜底)",
      "type": "openai",
      "enabled": true,
      "config": {
        "baseUrl": "https://text.pollinations.ai/openai",
        "apiKey": "none"
      }
    }
  ],
  "routes": {
    "deepseek-r1": [
      { "provider": "workbuddy", "model": "deepseek-v4-pro" },
      { "provider": "google_studio", "model": "gemini-2.0-flash-thinking-exp-01-21" },
      { "provider": "github_models", "model": "DeepSeek-R1" },
      { "provider": "openrouter", "model": "deepseek/deepseek-r1:free" },
      { "provider": "pollinations", "model": "deepseek-r1" }
    ],
    "claude-3-7-sonnet-20250219": [
      { "provider": "workbuddy", "model": "claude-3-7-sonnet-20250219" },
      { "provider": "github_models", "model": "o3-mini" },
      { "provider": "openrouter", "model": "anthropic/claude-3.7-sonnet" }
    ],
    "gemini-2.0-flash": [
      { "provider": "google_studio", "model": "gemini-2.0-flash" },
      { "provider": "openrouter", "model": "google/gemini-2.0-flash-exp:free" }
    ],
    "chat-fast": [
      { "provider": "zhipu", "model": "glm-4-flash" },
      { "provider": "google_studio", "model": "gemini-2.0-flash" },
      { "provider": "groq", "model": "llama-3.3-70b-versatile" }
    ]
  }
}
```
