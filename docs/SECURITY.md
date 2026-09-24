# 🔒 Security Guide - Universal AI Gateway

## 密钥管理最佳实践

### 1. 环境变量配置

**关键原则**: `MASTER_KEY` 与 `API_KEY` **必须不同**

```bash
# ❌ 错误示例（破坏安全边界）
API_KEY="sk-workbuddy-deepseek"
MASTER_KEY="sk-workbuddy-deepseek"  # 与 API_KEY 相同！

# ✅ 正确示例
API_KEY="sk-workbuddy-deepseek"
MASTER_KEY="$(openssl rand -hex 32)"  # 强随机值
```

**权限隔离**:
- `API_KEY`: 客户端密钥（Claude Code / CC-Switch / Cursor）
  - 可访问: `/v1/messages`, `/v1/chat/completions`, `/v1/models`
  - 不可访问: `/usage`, `/checkin`, `/status`
  
- `MASTER_KEY`: 管理密钥（运维/管理员）
  - 可访问: 所有端点
  - 可查询余额、执行签到、刷新配置

### 2. 生成安全密钥

```bash
# 生成 MASTER_KEY（256-bit 随机）
openssl rand -hex 32

# 生成 CRON_SECRET（128-bit 足够）
openssl rand -hex 16

# macOS 用户也可使用
LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
```

### 3. .env.local 安全检查清单

- [ ] **从未提交到 Git**
  ```bash
  # 检查历史记录
  git log --all --full-history -- .env.local
  
  # 如果曾提交，必须清理历史
  git filter-repo --path .env.local --invert-paths --force
  ```

- [ ] **已添加到 .gitignore**
  ```bash
  grep -q "^\.env\.local$" .gitignore && echo "✅" || echo "❌ 需要添加"
  ```

- [ ] **文件权限仅所有者可读**（Linux/macOS）
  ```bash
  chmod 600 .env.local
  ```

- [ ] **不包含测试/示例凭证**
  - ❌ `API_KEY="test"` / `MASTER_KEY="admin"`
  - ✅ 使用强随机值或真实凭证

### 4. 凭证轮换策略

**立即轮换（如果发生）**:
- [ ] `.env.local` 曾提交到公共仓库
- [ ] `MASTER_KEY` 与 `API_KEY` 配置相同
- [ ] 怀疑密钥泄露或未授权访问

**定期轮换（推荐）**:
- WorkBuddy AccessToken: 自动刷新（网关内置）
- MASTER_KEY: 每 90 天
- CRON_SECRET: 每 180 天

**轮换步骤**:
```bash
# 1. 生成新密钥
NEW_MASTER_KEY=$(openssl rand -hex 32)

# 2. 更新 Vercel 环境变量
vercel env add MASTER_KEY production
# 或在 Vercel 仪表盘: Settings > Environment Variables

# 3. 更新本地 .env.local
sed -i.bak "s/^MASTER_KEY=.*/MASTER_KEY=\"$NEW_MASTER_KEY\"/" .env.local

# 4. 通知所有使用者更新客户端配置
```

---

## 安全端点访问控制

### 权限矩阵

| 端点 | 公开访问 | API_KEY | MASTER_KEY | CRON_SECRET |
|------|---------|---------|------------|-------------|
| `/healthz` | ✅ | ✅ | ✅ | ✅ |
| `/status` | ❌ | ✅ | ✅ | ❌ |
| `/v1/messages` | ❌ | ✅ | ✅ | ❌ |
| `/v1/chat/completions` | ❌ | ✅ | ✅ | ❌ |
| `/v1/models` | ❌ | ✅ | ✅ | ❌ |
| `/v1/usage` | ❌ | ❌ | ✅ | ❌ |
| `/checkin` | ❌ | ❌ | ✅ | ✅ |

### Vercel Cron 配置注意事项

**问题**: Vercel 内建 cron 不发送 `Authorization` 头

**解决方案 A**: 留空 `CRON_SECRET`（仅 MASTER_KEY 可触发）
```bash
# .env.local
CRON_SECRET=""  # 留空，/checkin 只接受 MASTER_KEY
```
```bash
# 手动触发签到
curl -H "Authorization: Bearer $MASTER_KEY" https://your-gateway.vercel.app/checkin
```

**解决方案 B**: 使用外部 cron 服务（推荐生产环境）
```bash
# .env.local
CRON_SECRET="$(openssl rand -hex 16)"

# 注释掉 vercel.json 的 crons 配置
# "crons": [ ... ]  # 禁用内建 cron

# 使用 cron-job.org / GitHub Actions
curl -H "x-cron-secret: $CRON_SECRET" \
     https://your-gateway.vercel.app/checkin
```

---

## 已知安全防护机制

### ✅ 已实现

1. **常数时间密钥比较** (`timingSafeEqual`)
   - 防止时序攻击枚举密钥

2. **环境变量白名单** (`ENV_ALLOWLIST`)
   - 只读取声明的变量，防意外泄露

3. **请求大小限制** (8MB)
   - 先鉴权后解析，防 DoS

4. **Host Header 注入防护**
   - 白名单域名验证

5. **响应头过滤**
   - 屏蔽上游 `Set-Cookie` / `Location` / `X-RateLimit-*`

6. **11128 风控脱敏**
   - O(1) 快速门控 + 大小写不敏感替换

7. **Failover 与 Cooldown**
   - 指数退避 + 账号健康度调度

### ⚠️ 当前限制

1. **无 Rate Limiting**
   - 客户端可无限调用（依赖上游限流）
   - 建议: 补充基于 KV 的 token bucket

2. **日志未脱敏**
   - `console.error` 可能打印完整 payload
   - 建议: 脱敏敏感字段（token/userId）

3. **无审计日志**
   - 关键操作（签到/刷新 token）无持久化记录
   - 建议: 写入 KV 或 S3

---

## 漏洞上报

**联系方式**: 
- GitHub Issues (私密): https://github.com/Ericsunsk/Universal-AI-Gateway/security/advisories/new
- Email: [项目维护者邮箱]

**响应承诺**:
- 24 小时内确认收到
- 7 天内提供初步评估
- 关键漏洞 14 天内修复

**负责任披露**:
- 请给予合理修复时间再公开披露
- 我们会在修复后致谢（如您希望）

---

## 合规检查

### GDPR / 数据保护

- ✅ 不收集用户个人信息（除 WorkBuddy userId）
- ✅ 不持久化对话内容
- ⚠️ KV 存储的 cooldown 记录包含 userId（90 天 TTL）

### 日志保留

- Vercel 日志: 1 天（Hobby 计划）/ 3 天（Pro）
- KV 数据: 显式 TTL 控制（cooldown 8 小时，config 永久）

### 第三方依赖

- 零 npm 依赖（纯 Node.js 标准库）
- Upstash KV: REST API（HTTPS + Bearer Token）
- WorkBuddy: OAuth2 RefreshToken 流程

---

## 安全更新订阅

关注以下渠道获取安全通知:
- GitHub Watch: Releases only
- RSS: https://github.com/Ericsunsk/Universal-AI-Gateway/releases.atom
