#!/usr/bin/env node
// 查看最近一次依赖核对/安装的结果记录（.deps/install-report.json，本地持久化）
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', '.deps', 'install-report.json');

if (!fs.existsSync(file)) {
  console.error('尚无依赖记录，请先执行：npm run deps:ensure（或 deps:verify / deps:install）');
  process.exit(1);
}

const r = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log('状态       :', r.status);
console.log('记录时间   :', r.timestamp);
console.log('Node / npm :', `${r.node} / ${r.npm}`);
if (r.failedStep) console.log('失败步骤   :', r.failedStep);
if (r.detail) console.log('详情       :', r.detail);
console.log('日志文件   :', r.logFile);
if (r.previous) {
  console.log('上次记录   :', `${r.previous.status} @ ${r.previous.timestamp} (${r.previous.node})`);
}
if (r.locked && r.actual) {
  console.log('\n包版本（清单锁定 / 实际安装 / package.json 声明）:');
  const names = Object.keys(r.locked).sort();
  for (const name of names) {
    const mark = r.locked[name] === r.actual[name] ? 'OK ' : 'XX ';
    console.log(`  [${mark}] ${name.padEnd(24)} ${String(r.locked[name]).padEnd(9)} / ${String(r.actual[name]).padEnd(9)} / ${r.declared[name]}`);
  }
}
