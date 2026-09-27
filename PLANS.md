# Security Audit Fixes

## Goal
按审计顺序修复限流隔离、Web body size enforcement、SSRF DNS 校验和配置 fail-open。

## Scope
仅修改认证/限流、请求解析、URL guard、配置回退及对应测试；保持现有 API 字段和错误状态兼容。

## Success Criteria
针对性测试覆盖每项漏洞，完整 `npm test`、`npm run lint`、`npm audit --omit=dev --audit-level=moderate` 和 `git diff --check` 通过。

## Rollback
按文件回退本次变更即可；不修改远端、分支或持久化生产配置。
