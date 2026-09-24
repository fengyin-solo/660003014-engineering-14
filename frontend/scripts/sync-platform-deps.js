#!/usr/bin/env node
/**
 * sync-platform-deps.js
 *
 * 规避 npm optional dependencies 缺陷（github.com/npm/cli/issues/4828）：
 * lockfile 只记录“生成清单那台机器”的平台原生包，导致其他平台执行 npm ci 时
 * 漏掉 @rollup/rollup-<platform>、@esbuild/<platform> 而构建失败。
 *
 * 做法：把 vite 构建链里 rollup / esbuild 的全部平台可选包显式写入
 * package.json 的 optionalDependencies（各平台只实际安装匹配的那一份）。
 * 在 deps.sh 的“清单核对”之前自动执行，也可手动 `npm run deps:sync-platform`。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const lockPath = path.join(ROOT, 'package-lock.json');

const NATIVE_PREFIXES = ['@rollup/rollup-', '@esbuild/'];

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

// 找到 vite 构建链中的 rollup / esbuild 实际版本
const wanted = {};
for (const name of ['rollup', 'esbuild']) {
  const entry = lock.packages[`node_modules/${name}`];
  if (entry) wanted[name] = { version: entry.version, optionalDependencies: entry.optionalDependencies || {} };
}
if (Object.keys(wanted).length === 0) {
  console.error('[sync-platform] lockfile 中未找到 rollup/esbuild，跳过');
  process.exit(0);
}

const next = {};
for (const { version, optionalDependencies } of Object.values(wanted)) {
  for (const [optName, optVersion] of Object.entries(optionalDependencies)) {
    if (NATIVE_PREFIXES.some((p) => optName.startsWith(p))) {
      next[optName] = optVersion;
    }
  }
  // rollup 还会带 @napi-rs/lzma-* 等平台包，一并纳入
  for (const [optName, optVersion] of Object.entries(optionalDependencies)) {
    if (optName.startsWith('@napi-rs/')) next[optName] = optVersion;
  }
}

// 保留已有但与本次无关的 optionalDependencies（一般没有）
const prev = pkg.optionalDependencies || {};
const merged = Object.assign({}, prev, next);

const changed = JSON.stringify(prev, Object.keys(merged).sort()) !==
  JSON.stringify(merged, Object.keys(merged).sort());

pkg.optionalDependencies = merged;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

if (changed) {
  console.log(`[sync-platform] 已同步 ${Object.keys(next).length} 个平台原生包到 optionalDependencies（rollup/esbuild）`);
} else {
  console.log('[sync-platform] 平台原生包声明已是最新，无需改动');
}
