# Changelog

## [2.5.1] - 2024-09-24

### 🔒 Security Fixes

**Critical**:
- **H1**: Removed real production credentials from `.env.local`, added `.env.example` template
- **H2**: Enforced separation between `MASTER_KEY` and `API_KEY` (documented in `docs/SECURITY.md`)
- Added comprehensive security documentation (`docs/SECURITY.md`)

**Medium**:
- **M1**: Added `DEBUG` environment variable to whitelist (ENV_ALLOWLIST)
- **M2**: Removed production `console.log`/`console.debug` noise (gated behind `DEBUG=true`)
  - `src/core/cacheStats.js`: Cache hit logging now DEBUG-only
  - `src/config/config.js`: Route backfill logging now DEBUG-only
  - `src/exchange/reasoning.js`: Temperature override logging removed
- **M3**: Hardened `x-matched-path` validation (only accept `/api`, `/v1`, `/`, `/healthz`, `/status` prefixes)

### 📝 Documentation

- Created `.env.example` with secure credential generation instructions
- Added `docs/SECURITY.md` with best practices:
  - Key rotation procedures
  - Permission matrix
  - Vercel Cron security considerations
  - Vulnerability disclosure policy

### ✅ Testing

- Updated test suite to handle DEBUG-gated logging
- All 185 tests passing
- Environment variable whitelist coverage validated

### 🔄 Migration Guide

**If you have an existing `.env.local`:**

```bash
# 1. Backup current credentials
cp .env.local .env.local.backup

# 2. Generate new MASTER_KEY (must differ from API_KEY)
echo "MASTER_KEY=\"$(openssl rand -hex 32)\"" >> .env.local.new

# 3. Copy other credentials from backup
# 4. Replace .env.local with .env.local.new
# 5. Verify .env.local is in .gitignore
grep -q "^\.env\.local$" .gitignore || echo ".env.local" >> .gitignore

# 6. Check Git history (if .env.local was ever committed)
git log --all --full-history -- .env.local
# If found, rotate ALL credentials immediately and clean history:
# git filter-repo --path .env.local --invert-paths --force
```

**Production deployment checklist:**
- [ ] `MASTER_KEY` ≠ `API_KEY`
- [ ] `.env.local` not in version control
- [ ] All credentials rotated if previously leaked
- [ ] Vercel environment variables updated
- [ ] `DEBUG=false` or unset in production

---

## [2.5.0] - 2024-09-23

Previous stable release. See Git history for details.
