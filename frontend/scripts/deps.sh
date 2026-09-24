#!/usr/bin/env bash
# =============================================================================
# deps.sh — 依赖核对与安装的唯一入口（开发 / 构建共用）
#
# 流程固定为：环境核对 → 清单核对 → 安装（仅在需要时）→ 安装后复核 → 结果落盘
#
# 用法：
#   npm run deps:verify   只核对，不改动 node_modules；发现不一致即以非零码退出
#   npm run deps:install  无条件按清单重装（npm ci），用于明确要求重装的场景
#   npm run deps:ensure   核对；不一致则自动修复安装，再复核。供 predev/prebuild 调用
#
# 设计约定：
#   - package-lock.json 是唯一依赖清单，开发与构建共用，必须提交进仓库
#   - 任何环境 / 版本不一致都在日志中显式标注 [MISMATCH]/[ERROR]，绝不静默继续
#   - 每次执行都写日志到 logs/，并把最新版本结果写入 .deps/install-report.json，
#     重启后仍可查询（npm run deps:report）
# =============================================================================

set -uo pipefail

# ---------------------------------------------------------------------------
# 0. 路径与公共变量
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$FRONTEND_DIR"

MODE="${1:-ensure}"
case "$MODE" in
  verify|install|ensure) ;;
  *) echo "[ERROR] 未知模式: $MODE（支持 verify | install | ensure）" >&2; exit 2 ;;
esac

LOG_DIR="$FRONTEND_DIR/logs"
REPORT_DIR="$FRONTEND_DIR/.deps"
mkdir -p "$LOG_DIR" "$REPORT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/deps-$TS.log"
REPORT_FILE="$REPORT_DIR/install-report.json"

# 颜色（非 TTY 时自动关闭）
if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'; C_OFF=$'\033[0m'
else
  C_RED=''; C_YELLOW=''; C_GREEN=''; C_BLUE=''; C_OFF=''
fi

# 同时输出到终端与日志文件
_log() { printf '%s\n' "$*" | tee -a "$LOG_FILE"; }
info()  { _log "[INFO]  $*"; }
step()  { _log "${C_BLUE}[STEP]  $*${C_OFF}"; }
ok()    { _log "${C_GREEN}[OK]    $*${C_OFF}"; }
warn()  { _log "${C_YELLOW}[WARN]  $*${C_OFF}"; }
err()   { _log "${C_RED}[ERROR] $*${C_OFF}"; }
drift() { _log "${C_RED}[MISMATCH] $*${C_OFF}"; }

# 异常退出：明确指出卡在哪一步
fail_step() {
  local rc=$?
  local step_name="$1"; shift
  err "依赖流程在步骤【${step_name}】失败（退出码 $rc）"
  err "日志文件：$LOG_FILE"
  write_report "failed" "$step_name" "$*"
  trap - EXIT
  exit 1
}
trap 'rc=$?; if [ $rc -ne 0 ]; then err "异常终止，退出码 $rc，详见日志：$LOG_FILE"; fi' EXIT

# ---------------------------------------------------------------------------
# 结果落盘（重启后可通过 npm run deps:report 查询）
# ---------------------------------------------------------------------------
write_report() {
  local status="$1" failed_step="${2:-}" detail="${3:-}"
  node - "$REPORT_FILE" "$status" "$failed_step" "$detail" "$LOG_FILE" <<'NODE'
const fs = require('fs');
const [,, file, status, failedStep, detail, logFile] = process.argv;
let prev = null;
try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const report = {
  status,
  timestamp: new Date().toISOString(),
  node: process.version,
  npm: (() => { try { return require('child_process').execSync('npm -v').toString().trim(); } catch { return 'unknown'; } })(),
  cwd: process.cwd(),
  failedStep: failedStep || null,
  detail: detail || null,
  logFile,
  previous: prev ? { status: prev.status, timestamp: prev.timestamp, node: prev.node } : null,
};
// 附上当前清单与实际安装的版本快照
try {
  const lock = require('./package-lock.json');
  const root = lock.packages[''] || {};
  const declared = Object.assign({}, root.dependencies, root.devDependencies);
  const actual = {};
  for (const name of Object.keys(declared)) {
    try { actual[name] = require(`./node_modules/${name}/package.json`).version; }
    catch { actual[name] = null; }
  }
  const locked = {};
  for (const name of Object.keys(declared)) {
    locked[name] = (lock.packages[`node_modules/${name}`] || {}).version || null;
  }
  report.declared = declared;
  report.locked = locked;
  report.actual = actual;
} catch (e) { report.snapshotError = e.message; }
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
NODE
}

# ===========================================================================
# 步骤 1：环境核对（Node 版本、包管理器唯一性、npm 配置）
# ===========================================================================
step "1/5 环境核对"

ENV_PROBLEMS=0

# 1.1 Node 版本：以 .nvmrc 为准（主版本必须一致）
if [ -f "$FRONTEND_DIR/.nvmrc" ]; then
  REQUIRED_NODE="$(tr -d '[:space:]' < "$FRONTEND_DIR/.nvmrc")"
  ACTUAL_NODE="$(node -v)"
  REQUIRED_MAJOR="$(printf '%s' "$REQUIRED_NODE" | sed -E 's/^v?([0-9]+).*/\1/')"
  ACTUAL_MAJOR="$(printf '%s' "$ACTUAL_NODE" | sed -E 's/^v?([0-9]+).*/\1/')"
  if [ "$REQUIRED_MAJOR" = "$ACTUAL_MAJOR" ]; then
    ok "Node 版本匹配：要求 ${REQUIRED_NODE}，实际 ${ACTUAL_NODE}"
  else
    drift "Node 版本不一致：.nvmrc 要求 ${REQUIRED_NODE}（主版本 ${REQUIRED_MAJOR}），当前为 ${ACTUAL_NODE}（主版本 ${ACTUAL_MAJOR}）"
    warn "请切换 Node 版本后重试，例如：nvm use ${REQUIRED_MAJOR}"
    ENV_PROBLEMS=1
  fi
else
  warn "缺少 .nvmrc，无法核对 Node 版本基线"
fi
info "node=$(node -v)  npm=$(npm -v)  os=$(uname -srm)"

# 1.2 包管理器唯一性：本项目只认 npm + package-lock.json
FOREIGN_LOCKS=""
[ -f "$FRONTEND_DIR/yarn.lock" ] && FOREIGN_LOCKS="$FOREIGN_LOCKS yarn.lock"
[ -f "$FRONTEND_DIR/pnpm-lock.yaml" ] && FOREIGN_LOCKS="$FOREIGN_LOCKS pnpm-lock.yaml"
if [ -n "$FOREIGN_LOCKS" ]; then
  drift "发现其他包管理器的锁文件：${FOREIGN_LOCKS}；本项目统一使用 npm（package-lock.json），混用会导致依赖树不一致"
  ENV_PROBLEMS=1
fi

if [ "$ENV_PROBLEMS" -ne 0 ]; then
  err "环境核对未通过。为避免在不一致的环境里默默安装，流程在此停止。"
  write_report "failed" "环境核对" "Node 版本或包管理器与项目基线不一致"
  trap - EXIT
  exit 1
fi
ok "环境核对通过"

# ===========================================================================
# 步骤 2：清单核对（package.json ↔ package-lock.json ↔ node_modules）
# ===========================================================================
step "2/5 清单核对"

# 2.0 平台原生包同步：规避 npm optional deps 缺陷（npm/cli#4828），
#     保证 rollup/esbuild 各平台二进制都在 lock 中有记录、跨机器可装。
#     同步结果是平台无关的固定内容（全平台 + 精确版本），各机器生成结果一致。
if [ "$MODE" = "verify" ]; then
  # 只读校验：当前平台所需的原生包是否都在 lock 中（不修改任何文件）
  PLATFORM_CHECK="$(node <<'NODE'
const fs = require('fs');
let lock;
try { lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')); }
catch (e) { console.log(JSON.stringify({ok: false, reason: e.message})); process.exit(0); }
const need = [];
for (const [pkgPath, entry] of Object.entries(lock.packages)) {
  if (!entry.optionalDependencies) continue;
  for (const [opt, ver] of Object.entries(entry.optionalDependencies)) {
    if (!opt.startsWith('@rollup/rollup-') && !opt.startsWith('@esbuild/')) continue;
    const optEntry = lock.packages[`node_modules/${opt}`];
    if (!optEntry || optEntry.version !== ver) need.push(`${opt}@${ver}`);
  }
}
console.log(JSON.stringify({ok: need.length === 0, missing: need}));
NODE
)"
  PLATFORM_OK="$(printf '%s' "$PLATFORM_CHECK" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).ok)}catch(e){console.log(false)}})")"
  if [ "$PLATFORM_OK" != "true" ]; then
    drift "package-lock.json 缺少部分 rollup/esbuild 平台原生包，跨机器安装会失败"
    err "请在有网络的环境执行 npm run deps:ensure 或 deps:install 修复清单后再提交"
    write_report "failed" "清单核对（平台包只读校验）" "lock 缺少平台原生包"
    trap - EXIT
    exit 1
  fi
  info "平台原生包只读校验通过（verify 模式不修改清单）"
else
  # 修复/安装模式：同步 package.json → 生成 lock → 再同步，迭代至收敛（最多 3 轮）
  for round in 1 2 3; do
    if ! node scripts/sync-platform-deps.js 2>&1 | sed 's/^/[sync] /' | tee -a "$LOG_FILE"; then
      fail_step "清单核对（平台包同步）" "sync-platform-deps.js 执行失败"
    fi
    if ! npm install --package-lock-only --ignore-scripts >>"$LOG_FILE" 2>&1; then
      fail_step "清单核对（生成 package-lock.json）" "npm install --package-lock-only 失败，检查 package.json 或网络"
    fi
    PKG_BEFORE="$(sha256sum package.json | cut -d' ' -f1)"
    node scripts/sync-platform-deps.js >>"$LOG_FILE" 2>&1
    PKG_AFTER="$(sha256sum package.json | cut -d' ' -f1)"
    if [ "$PKG_BEFORE" = "$PKG_AFTER" ]; then
      break  # package.json 与新 lock 已一致，收敛
    fi
    info "平台包版本随清单更新（第 ${round} 轮），再次生成 package-lock.json"
  done
fi
PLATFORM_PKGS="$(node -e "const l=require('./package-lock.json'); console.log(Object.keys(l.packages).filter(k=>k.startsWith('node_modules/@rollup/rollup-')||k.startsWith('node_modules/@esbuild/')).length)")"
info "清单中平台原生包条目：${PLATFORM_PKGS} 个（覆盖 rollup/esbuild 全平台）"

if [ ! -f "$FRONTEND_DIR/package-lock.json" ]; then
  drift "缺少 package-lock.json（唯一依赖清单），任何安装都不可重复"
  err "请先执行：npm install --package-lock-only，并将 package-lock.json 提交到仓库"
  write_report "failed" "清单核对" "缺少 package-lock.json"
  trap - EXIT
  exit 1
fi

# 2.1 package.json 与 lock 是否同步；node_modules 实际版本是否与 lock 一致
#     输出 JSON：{ synced, drift: [{name, locked, actual, declared}] }
CHECK_JSON="$(node <<'NODE'
const fs = require('fs');
let lock;
try { lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')); }
catch (e) { console.log(JSON.stringify({fatal: '无法解析 package-lock.json: ' + e.message})); process.exit(0); }
const root = lock.packages && lock.packages[''];
if (!root) { console.log(JSON.stringify({fatal: 'package-lock.json 结构异常（缺少根条目）'})); process.exit(0); }
const declared = Object.assign({}, root.dependencies, root.devDependencies);
const drift = [];
for (const [name, spec] of Object.entries(declared)) {
  const locked = (lock.packages[`node_modules/${name}`] || {}).version || null;
  let actual = null;
  try { actual = require(`./node_modules/${name}/package.json`).version; } catch {}
  if (actual === null || actual !== locked) {
    drift.push({name, declared: spec, locked, actual});
  }
}
console.log(JSON.stringify({
  lockfileVersion: lock.lockfileVersion,
  declaredCount: Object.keys(declared).length,
  drift,
}));
NODE
)"
echo "$CHECK_JSON" >> "$LOG_FILE"

FATAL_CHECK="$(printf '%s' "$CHECK_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).fatal||'')}catch(e){console.log('核对脚本输出无法解析')}})")"
if [ -n "$FATAL_CHECK" ]; then
  err "$FATAL_CHECK"
  write_report "failed" "清单核对" "$FATAL_CHECK"
  trap - EXIT
  exit 1
fi

# 2.2 npm 原生复核：package.json 与 lock 不同步 / 树残缺时返回非零
if npm ls --omit=optional --depth=0 >/dev/null 2>"$LOG_DIR/.npm-ls.tmp"; then
  LS_OK=1
else
  LS_OK=0
  sed 's/^/[npm ls] /' "$LOG_DIR/.npm-ls.tmp" >> "$LOG_FILE"
fi
rm -f "$LOG_DIR/.npm-ls.tmp"

DRIFT_COUNT="$(printf '%s' "$CHECK_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).drift.length)}catch(e){console.log(-1)}})")"

if [ "$DRIFT_COUNT" -eq 0 ] && [ "$LS_OK" -eq 1 ]; then
  ok "清单一致：package.json、package-lock.json 与 node_modules 全部吻合"
  NEED_INSTALL=0
else
  if [ "$DRIFT_COUNT" -gt 0 ]; then
    drift "发现 ${DRIFT_COUNT} 个顶层依赖的实际版本与清单不符："
    printf '%s' "$CHECK_JSON" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  for (const d of JSON.parse(s).drift)
    console.log('           - ' + d.name + '：清单锁定 ' + d.locked + '，实际 ' + (d.actual||'未安装') + '（package.json 声明 ' + d.declared + '）');
});" | tee -a "$LOG_FILE"
  fi
  [ "$LS_OK" -eq 0 ] && drift "npm ls 复核未通过：依赖树残缺或 package.json 与 package-lock.json 不同步（详见日志）"
  NEED_INSTALL=1
fi

# verify 模式：只核对，不安装
if [ "$MODE" = "verify" ]; then
  if [ "$NEED_INSTALL" -eq 0 ]; then
    ok "核对完成，环境与清单一致，无需安装"
    write_report "verified" "" ""
    trap - EXIT
    exit 0
  else
    err "核对发现不一致（verify 模式不做修改）。请运行 npm run deps:install 按清单修复。"
    write_report "mismatch" "清单核对" "实际依赖与 package-lock.json 不一致"
    trap - EXIT
    exit 1
  fi
fi

# ===========================================================================
# 步骤 3：安装（清单与实际一致时跳过；install 模式强制重装）
# ===========================================================================
if [ "$MODE" = "install" ]; then
  NEED_INSTALL=1
  info "模式=install：按清单强制全新安装"
fi

if [ "$NEED_INSTALL" -eq 0 ]; then
  step "3/5 安装：跳过（清单一致，无需安装）"
else
  step "3/5 安装：按 package-lock.json 执行 npm ci（干净、可重复）"
  info "npm ci 会先清空 node_modules，再严格按清单安装，不会改写 package-lock.json"
  set -o pipefail
  npm ci 2>&1 | sed 's/^/[npm ci] /' | tee -a "$LOG_FILE"
  CI_RC="${PIPESTATUS[0]}"
  set +o pipefail

  # 独立完整性校验：npm 在部分崩溃场景（如 “Exit handler never called”）
  # 下会错误地以 0 退出且留下残缺的 node_modules，不能只信它的退出码
  CI_RESULT="$(node <<'NODE'
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const root = lock.packages[''];
const declared = Object.assign({}, root.dependencies, root.devDependencies, root.optionalDependencies);
const missing = [];
for (const name of Object.keys(declared)) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry || !entry.version) continue;
  // 带 os/cpu 限制的是跨平台二进制（rollup/esbuild），当前平台不匹配时本就不装，跳过
  if (entry.os || entry.cpu) continue;
  let actual = null;
  try { actual = require(`./node_modules/${name}/package.json`).version; } catch {}
  if (actual !== entry.version) missing.push({name, locked: entry.version, actual: actual || '未安装'});
}
console.log(JSON.stringify({missing}));
NODE
)"
  echo "$CI_RESULT" >> "$LOG_FILE"
  CI_MISSING="$(printf '%s' "$CI_RESULT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).missing.length)})")"
  CI_MISSING_NAMES="$(printf '%s' "$CI_RESULT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).missing.slice(0,10).map(m=>m.name+'('+m.actual+')').join(', '))})")"

  if [ "$CI_RC" -ne 0 ] || [ "$CI_MISSING" != "0" ]; then
    NPM_HINT="$(grep -E 'npm error' "$LOG_FILE" | grep -vE 'Exit handler|report this error|github.com/npm|complete log' | tail -5 | tr '\n' ' ')"
    err "npm ci 未成功完成（退出码 $CI_RC，缺失/不符包数 $CI_MISSING）"
    [ "$CI_MISSING" != "0" ] && err "未能装好的包：${CI_MISSING_NAMES}"
    [ -n "$NPM_HINT" ] && err "npm 错误信息：${NPM_HINT}"
    fail_step "安装（npm ci）" "安装未完成，请检查网络 / registry（$(npm config get registry)）后重试；包：${CI_MISSING_NAMES:-无}"
  fi
  ok "npm ci 执行完毕且独立完整性校验通过（退出码 0，无缺失包）"
fi

# ===========================================================================
# 步骤 4：安装后复核（必须与清单完全一致，否则视为失败）
# ===========================================================================
step "4/5 安装后复核"

POST_CHECK="$(node <<'NODE'
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const root = lock.packages[''];
const declared = Object.assign({}, root.dependencies, root.devDependencies);
const drift = [];
for (const [name, spec] of Object.entries(declared)) {
  const locked = (lock.packages[`node_modules/${name}`] || {}).version || null;
  let actual = null;
  try { actual = require(`./node_modules/${name}/package.json`).version; } catch {}
  if (actual !== locked) drift.push({name, locked, actual: actual || '未安装'});
}
console.log(JSON.stringify({drift}));
NODE
)"
echo "$POST_CHECK" >> "$LOG_FILE"

POST_DRIFT="$(printf '%s' "$POST_CHECK" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).drift.length)})")"
if [ "$POST_DRIFT" != "0" ]; then
  drift "安装后复核仍未通过，以下包与清单不符："
  printf '%s' "$POST_CHECK" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  for (const d of JSON.parse(s).drift)
    console.log('           - ' + d.name + '：应为 ' + d.locked + '，实际 ' + d.actual);
});" | tee -a "$LOG_FILE"
  err "安装结果与清单不一致，已停止以防在错误依赖上继续开发或构建"
  write_report "failed" "安装后复核" "安装后版本仍与 package-lock.json 不一致"
  trap - EXIT
  exit 1
fi

if ! npm ls --omit=optional --depth=0 >/dev/null 2>"$LOG_DIR/.npm-ls-post.tmp"; then
  sed 's/^/[npm ls] /' "$LOG_DIR/.npm-ls-post.tmp" | tee -a "$LOG_FILE"
  err "安装后 npm ls 复核失败：依赖树存在缺失或多余包"
  write_report "failed" "安装后复核" "npm ls 失败"
  rm -f "$LOG_DIR/.npm-ls-post.tmp"
  trap - EXIT
  exit 1
fi
rm -f "$LOG_DIR/.npm-ls-post.tmp"
ok "安装后复核通过：所有包版本与 package-lock.json 完全一致"

# ===========================================================================
# 步骤 5：结果落盘
# ===========================================================================
step "5/5 结果记录"
if [ "$NEED_INSTALL" -eq 0 ]; then
  write_report "verified" "" ""
else
  write_report "installed" "" ""
fi
ok "版本结果已记录：$REPORT_FILE"
info "完整日志：$LOG_FILE（历史日志见 $LOG_DIR/）"
ok "依赖流程完成，环境可重复"
trap - EXIT
exit 0
