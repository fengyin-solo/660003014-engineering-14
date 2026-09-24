#!/usr/bin/env node
/**
 * deps-sync.js —— 依赖核对与安装的唯一入口（开发环境与构建流程共用）
 *
 * 固定流程（每次执行严格按顺序进行）：
 *   阶段 1  环境核对   Node/npm 版本、registry、平台；并与上一次成功安装记录比对
 *   阶段 2  清单核对   package.json 与 package-lock.json 是否一致、锁文件是否被改动
 *   阶段 3  安装       仅当存在漂移/缺失时执行 `npm ci`（严格按锁文件安装）
 *   阶段 4  复核与记录 安装结果再次核对，版本结果写入 .deps/（重启后仍可查）
 *
 * 用法：
 *   node scripts/deps-sync.js           # 完整流程：核对 ->（按需）安装 -> 复核 -> 记录
 *   node scripts/deps-sync.js --check   # 只核对不安装；发现任何漂移即以非 0 退出
 *
 * 退出码：0 一致；1 发现不一致或安装失败（日志中逐项点名，绝不静默继续）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

// ----------------------------------------------------------------------------
// 路径与常量
// ----------------------------------------------------------------------------
const FRONTEND_DIR = path.resolve(__dirname, '..');
const STATE_DIR = path.join(FRONTEND_DIR, '.deps');
const RECORD_FILE = path.join(STATE_DIR, 'install-record.json');
const HISTORY_FILE = path.join(STATE_DIR, 'install-history.ndjson');
const INSTALL_LOG = path.join(STATE_DIR, 'last-install.log');
const PKG_FILE = path.join(FRONTEND_DIR, 'package.json');
const LOCK_FILE = path.join(FRONTEND_DIR, 'package-lock.json');
const NVMRC_FILE = path.join(FRONTEND_DIR, '.nvmrc');
const OTHER_LOCKS = ['yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json'];
const HISTORY_LIMIT = 200;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

const CHECK_ONLY = process.argv.includes('--check');
const startedAt = Date.now();
const warnings = [];
const hardErrors = [];

// ----------------------------------------------------------------------------
// 输出
// ----------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const bold = (s) => paint('1', s);

const log = (msg) => console.log(`${cyan('[deps]')} ${msg}`);
const okLine = (msg) => log(`${green('✓')} ${msg}`);
const warnLine = (msg) => {
  warnings.push(msg);
  log(`${yellow('!')} ${yellow('环境/状态不一致：' + msg)}`);
};
const errLine = (msg) => {
  hardErrors.push(msg);
  log(`${red('✗')} ${red(msg)}`);
};
const phase = (n, title) => log(bold(`\n==== 阶段 ${n}/4：${title} ====`));

function dieIfErrors(hint) {
  if (hardErrors.length === 0) return;
  log(red(bold(`\n核对未通过，共 ${hardErrors.length} 项问题（已中止，未做任何安装）：`)));
  hardErrors.forEach((m) => log(red(`  - ${m}`)));
  if (hint) log(yellow(hint));
  process.exit(1);
}

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function captureNpm(args) {
  return execFileSync(npmBin, args, { cwd: FRONTEND_DIR, encoding: 'utf8' }).trim();
}

function parseVersion(v) {
  const m = String(v).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function readLastRecord() {
  if (!fs.existsSync(RECORD_FILE)) return null;
  try {
    return readJson(RECORD_FILE);
  } catch {
    warnLine(`${path.relative(FRONTEND_DIR, RECORD_FILE)} 已损坏，无法作为比对基准（将重新生成）`);
    return null;
  }
}

/** 直接读取磁盘上某包的实际版本（npm ls 只报期望值，发现不了磁盘被改/半安装） */
function diskVersion(name) {
  const p = path.join(FRONTEND_DIR, 'node_modules', ...name.split('/'), 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    return v ? String(v) : null;
  } catch {
    return 'INVALID_JSON';
  }
}

/** 按锁文件全量核对磁盘：返回缺失/损坏/版本漂移的包（跳过平台不适用的 optionalDependencies） */
function verifyDiskAgainstLock(lock) {
  const missingPkg = [];
  const driftedPkg = [];
  for (const [pkgPath, meta] of Object.entries(lock.packages || {})) {
    if (pkgPath === '' || !pkgPath.startsWith('node_modules/')) continue;
    if (meta.optional === true || meta.os || meta.cpu || meta.libc) continue;
    const name = pkgPath.replace(/^node_modules\//, '');
    const actual = diskVersion(name);
    if (actual == null) {
      missingPkg.push({ name, locked: meta.version });
    } else if (actual === 'INVALID_JSON' || actual !== meta.version) {
      driftedPkg.push({ name, actual, locked: meta.version });
    }
  }
  return { missingPkg, driftedPkg };
}

/** 已安装的顶层依赖实际版本（npm ls --json --depth=0，用于识别 extraneous 等树级问题） */
function inspectInstalled() {
  let out = '';
  try {
    out = execFileSync(npmBin, ['ls', '--json', '--depth=0'], {
      cwd: FRONTEND_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // npm ls 在发现 missing/invalid 时会以 1 退出，但 stdout 仍是完整 JSON
    out = e.stdout ? e.stdout.toString() : '';
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch {
    return { parseError: true, items: {} };
  }
  const items = {};
  for (const [name, info] of Object.entries(data.dependencies || {})) {
    items[name] = {
      version: info.version || null,
      missing: info.required && info.version == null,
      problems: Array.isArray(info.problems) ? info.problems : [],
    };
  }
  return { parseError: false, items };
}

/** 从 npm ci 的输出里定位失败步骤与可疑包 */
function analyzeInstallFailure(output, code) {
  const text = output.toString();
  const lines = text.split(/\r?\n/);
  const pkgs = new Set();
  let step = '未知';

  const add = (p) => {
    if (p && !/^(npm|node)$/.test(p)) pkgs.add(p);
  };

  if (/gyp ERR!|node-gyp|prebuild-install/.test(text)) {
    step = '原生模块编译（node-gyp，通常缺少 Python / 编译器或预编译包下载失败）';
  }
  if (/EINTEGRITY|integrity checksum failed|checksum failed when using sha/.test(text)) {
    step = '完整性校验（下载内容与锁文件 integrity 不符，多为缓存损坏或锁文件被改动）';
  }
  if (/E404|404 Not Found|ETARGET|No matching version/.test(text)) {
    step = '包下载/版本解析（registry 上找不到对应包或版本）';
  }
  if (/ERESOLVE|Could not resolve dependency|Conflicting peer dependency|While resolving/.test(text)) {
    step = '依赖树解析（ERESOLVE，peerDependencies 冲突）';
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network/.test(text)) {
    step = '网络连接（无法访问 registry）';
  }

  for (const line of lines) {
    let m = line.match(/tarball data for\s+([@\w./-]+)@https?:\/\//);
    if (m) add(m[1]);
    m = line.match(/GET https?:\/\/[^\s]+\/([^/]+)\/-\/[^/\s]+\.tgz/);
    if (m) add(decodeURIComponent(m[1]));
    m = line.match(/While resolving:\s+(\S+)/);
    if (m) add(m[1]);
    m = line.match(/Conflicting peer dependency:\s+\S+\s+(\S+)/);
    if (m) add(m[1].replace(/@[^@]+$/, ''));
    m = line.match(/No matching version found for\s+([@\w./-]+)/);
    if (m) add(m[1]);
  }

  const codes = [...new Set(lines.filter((l) => /^npm error code\s+/.test(l)).map((l) => l.replace(/^npm error code\s+/, '').trim()))];
  const hints = [];
  if (codes.includes('EINTEGRITY')) hints.push('可尝试 `npm cache clean --force` 后重新执行 npm run deps:sync');
  if (codes.some((x) => /^E/.test(x) && /NOTFOUND|REFUSED|RESET|TIMEDOUT/.test(x))) hints.push('检查网络/代理与 registry 配置（npm config get registry）');
  return { step, code, npmCodes: codes, packages: [...pkgs], hints };
}

function runNpmCi() {
  return new Promise((resolve) => {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(INSTALL_LOG, `# npm ci @ ${new Date().toISOString()}\n`);
    let tail = '';
    const absorb = (chunk, sink) => {
      const s = chunk.toString();
      sink.write(s);
      fs.appendFileSync(INSTALL_LOG, s);
      tail += s;
      if (tail.length > 400000) tail = tail.slice(-400000);
    };
    const child = spawn(npmBin, ['ci', '--no-audit', '--no-fund'], {
      cwd: FRONTEND_DIR,
      env: process.env,
    });
    child.stdout.on('data', (d) => absorb(d, process.stdout));
    child.stderr.on('data', (d) => absorb(d, process.stderr));
    child.on('error', (err) => resolve({ code: -1, output: tail, spawnError: err.message }));
    child.on('close', (code) => resolve({ code, output: tail }));
  });
}

// ----------------------------------------------------------------------------
// 主流程
// ----------------------------------------------------------------------------
async function main() {
  log(bold(CHECK_ONLY ? '依赖核对（--check，只核对不安装）' : '依赖核对与安装（完整流程）'));
  log(`工程目录：${FRONTEND_DIR}`);

  const manifest = readJson(PKG_FILE);
  const declared = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
  };
  const isDevDep = new Set(Object.keys(manifest.devDependencies || {}));
  const lastRecord = readLastRecord();

  // ---- 阶段 1：环境核对 -----------------------------------------------------
  phase(1, '环境核对');
  const actualNode = process.versions.node;
  let expectedNode = null;
  if (fs.existsSync(NVMRC_FILE)) {
    expectedNode = fs.readFileSync(NVMRC_FILE, 'utf8').trim();
  } else {
    errLine('缺少 .nvmrc，无法确定期望的 Node 版本');
  }
  const aNode = parseVersion(actualNode);
  const eNode = parseVersion(expectedNode);
  if (aNode && eNode) {
    if (aNode.major !== eNode.major) {
      errLine(`Node 主版本不一致：当前 ${actualNode}，清单要求 ${expectedNode}（请用 nvm use 切换，勿在此环境继续）`);
    } else if (`${aNode.minor}.${aNode.patch}` !== `${eNode.minor}.${eNode.patch}`) {
      warnLine(`Node 版本与清单不完全一致：当前 ${actualNode}，期望 ${expectedNode}（主版本一致，继续执行）`);
    } else {
      okLine(`Node ${actualNode} 与清单一致`);
    }
  }

  let actualNpm = '';
  try {
    actualNpm = captureNpm(['-v']);
  } catch {
    errLine('未找到 npm 可执行文件，无法继续');
  }
  const pmMatch = String(manifest.packageManager || '').match(/^npm@(.+)$/);
  const expectedNpm = pmMatch ? pmMatch[1] : null;
  if (actualNpm && expectedNpm) {
    const a = parseVersion(actualNpm);
    const e = parseVersion(expectedNpm);
    if (a && e) {
      if (a.major !== e.major) {
        errLine(`npm 主版本不一致：当前 ${actualNpm}，清单要求 ${expectedNpm}（锁文件格式可能不同，禁止继续安装）`);
      } else if (`${a.minor}.${a.patch}` !== `${e.minor}.${e.patch}`) {
        warnLine(`npm 版本与清单不完全一致：当前 ${actualNpm}，期望 ${expectedNpm}（主版本一致，继续执行）`);
      } else {
        okLine(`npm ${actualNpm} 与清单一致`);
      }
    }
  } else if (!expectedNpm) {
    errLine('package.json 缺少 "packageManager": "npm@x.y.z"，无法固定 npm 版本');
  }

  let registry = '';
  try {
    registry = captureNpm(['config', 'get', 'registry']);
  } catch {
    registry = '(无法读取)';
  }
  if (registry.replace(/\/$/, '') !== DEFAULT_REGISTRY.replace(/\/$/, '')) {
    warnLine(`npm registry 非默认源：当前 ${registry}，默认 ${DEFAULT_REGISTRY}（将以锁文件 resolved/integrity 为准）`);
  } else {
    okLine(`registry ${registry}`);
  }

  const platform = `${process.platform}-${process.arch}`;
  if (lastRecord && lastRecord.toolchain && lastRecord.toolchain.platform !== platform) {
    warnLine(`运行平台与上次成功安装时不同：当时 ${lastRecord.toolchain.platform}，现在 ${platform}（原生依赖需按本平台重装）`);
  }
  if (lastRecord && lastRecord.toolchain && lastRecord.toolchain.node && lastRecord.toolchain.node !== actualNode) {
    warnLine(`Node 版本与上次成功安装时不同：当时 ${lastRecord.toolchain.node}，现在 ${actualNode}`);
  }
  okLine(`平台 ${platform}（${os.type()} ${os.release()}）`);

  // ---- 阶段 2：清单核对 -----------------------------------------------------
  phase(2, '清单核对（package.json ↔ package-lock.json）');
  const foreignLock = OTHER_LOCKS.find((f) => fs.existsSync(path.join(FRONTEND_DIR, f)));
  if (foreignLock) errLine(`检测到其他包管理器的锁文件 ${foreignLock}：本项目只允许使用 npm 与 package-lock.json，请删除后再继续`);

  if (!fs.existsSync(LOCK_FILE)) {
    errLine('缺少 package-lock.json：它是全团队/CI 唯一的依赖版本清单，必须随仓库提交');
  }
  let lock = null;
  let lockSha = null;
  if (fs.existsSync(LOCK_FILE)) {
    try {
      lock = readJson(LOCK_FILE);
      lockSha = fileSha256(LOCK_FILE);
    } catch (e) {
      errLine(`package-lock.json 解析失败：${e.message}`);
    }
  }
  dieIfErrors();

  if (lock.lockfileVersion !== 3) {
    errLine(`锁文件版本 lockfileVersion=${lock.lockfileVersion}，要求 3（请用 npm@10 重新生成）`);
  }
  const lockRoot = lock.packages && lock.packages[''] ? lock.packages[''] : {};
  const lockRanges = {
    ...(lockRoot.dependencies || {}),
    ...(lockRoot.devDependencies || {}),
  };
  const manifestNames = Object.keys(declared).sort();
  const lockNames = Object.keys(lockRanges).sort();
  const missingInLock = manifestNames.filter((n) => !(n in lockRanges));
  const extraInLock = lockNames.filter((n) => !(n in declared));
  const driftedRanges = manifestNames.filter((n) => n in lockRanges && String(declared[n]).trim() !== String(lockRanges[n]).trim());
  missingInLock.forEach((n) => errLine(`清单缺失：${n}@${declared[n]} 在 package.json 中声明，但锁文件里没有（修改依赖后必须提交新的 package-lock.json）`));
  extraInLock.forEach((n) => errLine(`清单多余：${n} 存在于锁文件根依赖，但 package.json 未声明`));
  driftedRanges.forEach((n) => errLine(`清单不一致：${n} 在 package.json 为 ${declared[n]}，锁文件记录为 ${lockRanges[n]}（请重新生成并提交锁文件）`));
  if (!missingInLock.length && !extraInLock.length && !driftedRanges.length) {
    okLine(`package.json 与锁文件根依赖完全一致（共 ${manifestNames.length} 项）`);
  }

  if (!lastRecord) {
    log(yellow('! 本机没有历史安装记录，将以完整安装建立基准'));
  } else if (lastRecord.lockfile && lastRecord.lockfile.sha256 !== lockSha) {
    warnLine('package-lock.json 自上次成功安装后发生过改动（sha256 不一致），将重新安装对齐');
  } else {
    okLine('锁文件 sha256 与上次成功安装记录一致');
  }

  const lockedVersion = (name) => {
    const p = lock.packages[`node_modules/${name}`];
    return p && p.version ? p.version : null;
  };
  const totalPackages = Object.keys(lock.packages || {}).filter((p) => p !== '').length;
  okLine(`锁文件共锁定 ${totalPackages} 个包（含传递依赖），sha256=${lockSha.slice(0, 16)}…`);
  dieIfErrors();

  // ---- 阶段 3：安装前核对实际版本（+ 按需安装） ------------------------------
  phase(3, CHECK_ONLY ? '安装前核对（--check 模式：只核对，不安装）' : '安装前核对 / 安装');
  const nodeModulesOk = fs.existsSync(path.join(FRONTEND_DIR, 'node_modules'));
  const installed = inspectInstalled();
  const missing = [];
  const mismatch = [];
  const invalid = [];

  if (installed.parseError) {
    if (nodeModulesOk) warnLine('无法解析 `npm ls --json` 的结果，node_modules 状态可疑');
  }
  for (const name of manifestNames) {
    const locked = lockedVersion(name);
    const info = installed.items[name];
    if (!nodeModulesOk || !info || info.missing || !info.version) {
      missing.push(name);
    } else if (locked && info.version !== locked) {
      mismatch.push({ name, actual: info.version, locked });
    }
    if (info && info.problems.some((p) => /invalid|extraneous/.test(p))) {
      invalid.push({ name, problems: info.problems.join('; ') });
    }
  }

  // 全量磁盘核对：对锁文件里每个（非平台可选）包读 node_modules 下的实际版本
  const disk = nodeModulesOk ? verifyDiskAgainstLock(lock) : { missingPkg: [], driftedPkg: [] };
  const topMissing = new Set(missing);
  const topDrift = new Set(mismatch.map((m) => m.name));
  disk.missingPkg.forEach((m) => {
    if (!topMissing.has(m.name)) log(yellow(`! 缺失包：${m.name}（清单锁定 ${m.locked}）`));
  });
  disk.driftedPkg.forEach((m) => {
    if (!topDrift.has(m.name)) log(yellow(`! 磁盘版本漂移：${m.name} 实际 ${m.actual} ≠ 清单 ${m.locked}`));
  });

  missing.forEach((n) => log(yellow(`! 未安装：${n}（清单锁定 ${lockedVersion(n)}）`)));
  mismatch.forEach((m) => log(yellow(`! 版本漂移：${m.name} 实际 ${m.actual} ≠ 清单 ${m.locked}`)));
  invalid.forEach((m) => log(yellow(`! 状态异常：${m.name}（${m.problems}）`)));

  const needInstall = !nodeModulesOk
    || missing.length > 0
    || mismatch.length > 0
    || invalid.length > 0
    || disk.missingPkg.length > 0
    || disk.driftedPkg.length > 0
    || !lastRecord
    || (lastRecord.lockfile && lastRecord.lockfile.sha256 !== lockSha)
    || (lastRecord.toolchain && lastRecord.toolchain.platform !== platform);

  if (CHECK_ONLY) {
    if (needInstall) {
      missing.forEach((n) => errLine(`未安装依赖：${n}（期望 ${lockedVersion(n)}）`));
      mismatch.forEach((m) => errLine(`版本漂移：${m.name} 实际 ${m.actual}，清单 ${m.locked}`));
      invalid.forEach((m) => errLine(`依赖状态异常：${m.name}（${m.problems}）`));
      disk.missingPkg.forEach((m) => {
        if (!topMissing.has(m.name)) errLine(`缺失包：${m.name}（期望 ${m.locked}）`);
      });
      disk.driftedPkg.forEach((m) => {
        if (!topDrift.has(m.name)) errLine(`磁盘版本与清单不符：${m.name} 实际 ${m.actual}，清单 ${m.locked}`);
      });
      if (!missing.length && !mismatch.length && !invalid.length
        && !disk.missingPkg.length && !disk.driftedPkg.length) {
        errLine('本机依赖状态与锁文件/环境记录不一致，需要重新执行安装对齐');
      }
    }
    dieIfErrors('请执行 `npm run deps:sync`（等价于按锁文件重新安装）后再运行 dev/build。');
    okLine('实际安装版本与清单完全一致，无需安装');
  } else {
    let action = 'verify-only';
    let failure = null;
    if (!needInstall) {
      okLine('核对一致：Node/npm、清单与已装版本均无漂移，跳过安装');
    } else {
      log(bold('存在漂移或本机无基准记录，执行严格安装：npm ci --no-audit --no-fund'));
      log('（npm ci 会先清空 node_modules，再按 package-lock.json 原样安装）');
      action = 'install';
      const result = await runNpmCi();
      if (result.spawnError) {
        failure = { step: '启动 npm 进程', code: result.code, packages: [], npmCodes: [], hints: [], detail: result.spawnError };
      } else if (result.code !== 0) {
        failure = analyzeInstallFailure(result.output, result.code);
      }
      if (failure) {
        errLine(`安装失败，退出码 ${failure.code}，卡在：${failure.step}`);
        if (failure.packages.length) errLine(`相关包：${[...new Set(failure.packages)].join(', ')}`);
        failure.npmCodes.forEach((c) => errLine(`npm 错误码：${c}`));
        log(red(`完整安装日志：${INSTALL_LOG}`));
        failure.hints.forEach((h) => log(yellow(`提示：${h}`)));
        // 失败也落盘，重启后仍可追溯
        writeRecord({ result: 'failed', action, lock, lockSha, totalPackages, declared, lockedVersion, installed: inspectInstalled(), manifestNames, isDevDep, actualNode, actualNpm, registry, platform, failure, warnings });
        process.exit(1);
      }
      okLine('npm ci 执行结束');
    }

    // ---- 阶段 4：复核与记录 ------------------------------------------------
    phase(4, '安装后复核与记录');
    const after = inspectInstalled();
    const afterDisk = verifyDiskAgainstLock(lock);
    const stillBad = [];
    if (after.parseError) stillBad.push('无法解析 npm ls 结果');
    for (const name of manifestNames) {
      const info = after.items[name];
      const locked = lockedVersion(name);
      if (!info || info.missing || !info.version) stillBad.push(`${name} 仍未安装`);
      else if (info.version !== locked) stillBad.push(`${name} 装后版本 ${info.version} ≠ 清单 ${locked}`);
    }
    afterDisk.missingPkg.forEach((m) => stillBad.push(`${m.name} 装后仍缺失`));
    afterDisk.driftedPkg.forEach((m) => stillBad.push(`${m.name} 装后磁盘版本 ${m.actual} ≠ 清单 ${m.locked}`));
    if (stillBad.length) {
      stillBad.slice(0, 50).forEach((m) => errLine(`复核失败：${m}`));
      if (stillBad.length > 50) errLine(`复核失败：另有 ${stillBad.length - 50} 项问题未显示`);
      writeRecord({ result: 'failed', action, lock, lockSha, totalPackages, declared, lockedVersion, installed: after, manifestNames, isDevDep, actualNode, actualNpm, registry, platform, failure: { step: '安装后复核', packages: stillBad.slice(0, 50) }, warnings });
      dieIfErrors();
    }
    okLine(`复核通过：磁盘上 ${totalPackages} 个包的版本与锁文件逐项一致`);

    const record = writeRecord({ result: 'success', action, lock, lockSha, totalPackages, declared, lockedVersion, installed: after, manifestNames, isDevDep, actualNode, actualNpm, registry, platform, failure: null, warnings });
    printDepTable(record);
    log(green(bold(`\n全部通过（${action === 'install' ? '已按清单安装' : '仅核对，未改动 node_modules'}，耗时 ${Date.now() - startedAt} ms）`)));
    log(`版本结果已记录到：${RECORD_FILE}`);
    log(`历史记录（每次执行追加一行）：${HISTORY_FILE}`);
    log('这些文件位于本机 .deps/ 目录（已 gitignore），重启后仍可查；`npm run deps:check` 可随时复核。');
  }

  function writeRecord(args) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const deps = {};
    for (const name of args.manifestNames) {
      const info = args.installed.items[name] || {};
      deps[name] = {
        scope: args.isDevDep.has(name) ? 'dev' : 'prod',
        declared: args.declared[name],
        locked: args.lockedVersion(name),
        installed: info.version || null,
      };
    }
    const record = {
      recordedAt: new Date().toISOString(),
      result: args.result,
      action: args.action,
      durationMs: Date.now() - startedAt,
      toolchain: {
        node: args.actualNode,
        nodeExpected: expectedNode,
        npm: args.actualNpm,
        npmExpected: expectedNpm,
        platform: args.platform,
        registry: args.registry,
      },
      lockfile: {
        name: 'package-lock.json',
        version: args.lock.lockfileVersion,
        sha256: args.lockSha,
        totalPackages: args.totalPackages,
      },
      dependencies: deps,
      warnings: args.warnings,
      failure: args.failure,
    };
    fs.writeFileSync(RECORD_FILE, JSON.stringify(record, null, 2) + '\n');
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
    try {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      if (lines.length > HISTORY_LIMIT) {
        fs.writeFileSync(HISTORY_FILE, lines.slice(-HISTORY_LIMIT).join('\n') + '\n');
      }
    } catch { /* 历史裁剪失败不影响主流程 */ }
    return record;
  }
}

function printDepTable(record) {
  const rows = Object.entries(record.dependencies);
  const w = Math.max(...rows.map(([n]) => n.length), 'package'.length);
  log(bold(
    `${'package'.padEnd(w)}  ${'declared'.padEnd(10)} ${'locked'.padEnd(10)} installed`,
  ));
  for (const [name, d] of rows) {
    const mark = d.installed === d.locked ? green('✓') : red('✗');
    log(`${mark} ${name.padEnd(w)}  ${String(d.declared).padEnd(10)} ${String(d.locked).padEnd(10)} ${d.installed}`);
  }
}

main().catch((e) => {
  log(red(`执行异常：${e && e.stack ? e.stack : e}`));
  process.exit(1);
});
