# solo-6600030: 有限元应力热力图可视化

## 技术栈
- Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS + Canvas 2D

## 核心特性
1. **2D 桁架 FEA 求解器**：单元刚度矩阵组装 + 高斯消元求解
2. **Jet 色图应力热力图**：蓝→青→绿→黄→红 应力分布
3. **3 种预设模型**：悬臂梁、桥梁桁架、简单框架
4. **变形网格叠加**：缩放位移后的变形网格虚线叠加
5. **交互式编辑**：点击选中单元查看详情，拖拽/缩放画布
6. **载荷与约束可视化**：力箭头、固定端三角标记
7. **热力图模式切换**：应力/应变/内力 三种显示模式

## 依赖安装与核对（开发与构建共用同一套流程）

为避免“各机器装出来的版本不一样”，本项目固定使用 **npm**，以随仓库提交的
`frontend/package-lock.json`（含每个包的版本与 integrity）作为**唯一版本清单**。
开发环境与 CI/构建都必须走同一个脚本，先核对、再安装、安装后复核并记录：

```bash
cd frontend
npm run deps:sync     # 完整流程：核对 →（按需）npm ci 安装 → 复核 → 记录到 .deps/
npm run deps:check    # 只核对不安装；发现任何漂移即以非 0 退出
```

`npm run dev` 与 `npm run build` 已通过 `predev`/`prebuild` 钩子自动执行
`deps:check`：环境或依赖与清单不一致时会**点名并中止**，不会默默继续。

流程四阶段（`frontend/scripts/deps-sync.js`）：

1. **环境核对**：Node（以 `.nvmrc` 为准）、npm（以 `package.json` 的
   `packageManager` 为准）、registry、平台；主版本不一致直接失败，次版本/registry/
   平台变化在日志中告警。
2. **清单核对**：`package.json` 声明与锁文件逐项比对；检测 yarn/pnpm 锁文件、
   锁文件缺失/被改动。
3. **安装前核对 / 安装**：直接读取 `node_modules` 下全部包的实际版本，与锁文件
   逐一比对（npm ls 只报期望值，读不到磁盘篡改，所以脚本自己读盘）。发现缺失、
   版本漂移、锁文件变化才执行 `npm ci`（先清空再按锁文件原样安装）。安装失败会
   指出**卡在哪个步骤、涉及哪个包、npm 错误码**，并把失败结果落盘。
4. **复核与记录**：安装后再次全量核对磁盘版本；通过后把本次工具链、锁文件
   sha256、每个包的 declared/locked/installed 版本写入 `.deps/`（重启后可查）。

本地文件（均已 gitignore，不入库）：

- `.deps/install-record.json`：最近一次执行结果（成功/失败）
- `.deps/install-history.ndjson`：每次执行追加一行的历史
- `.deps/last-install.log`：最近一次 `npm ci` 完整日志

变更依赖的正确姿势：修改 `package.json` 后运行 `npm install --package-lock-only`
（或正常 `npm install <pkg>`）更新锁文件，**把 `package-lock.json` 一起提交**，
然后 `npm run deps:sync` 建立新基准。不要直接手改 `node_modules`，也不要引入
yarn/pnpm。
