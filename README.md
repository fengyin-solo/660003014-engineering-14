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

## 依赖管理（开发与构建共用同一流程）

为避免「不同机器装出不同版本」，前端依赖统一走 `frontend/scripts/deps.sh`，
`npm run dev` / `npm run build` 会通过 `predev` / `prebuild` 钩子自动执行，无需手动操作。

- **唯一清单**：`frontend/package-lock.json`（锁定全部传递依赖的精确版本），
  必须提交仓库；统一使用 **npm**，禁止混用 yarn/pnpm（出现其锁文件会被流程拦截）。
- **Node 版本基线**：`frontend/.nvmrc`（Node 20），版本不符流程直接停止并提示 `nvm use`。

### 命令（在 `frontend/` 下执行）

| 命令 | 作用 |
| --- | --- |
| `npm run deps:verify` | 只读核对：环境 / 清单 / 实际版本，不一致即以非零码退出（CI 用） |
| `npm run deps:ensure` | 核对；不一致则按清单 `npm ci` 修复，再复核（dev/build 自动调用） |
| `npm run deps:install` | 无条件按清单干净重装（先清空 `node_modules`） |
| `npm run deps:report` | 查看最近一次核对/安装结果与各包版本快照 |

### 固定流程（5 步，任何一步失败都显式停止，绝不静默继续）

1. **环境核对**：Node 主版本 vs `.nvmrc`；排查 yarn/pnpm 锁文件。
2. **清单核对**：校验 `package.json` ↔ `package-lock.json` ↔ `node_modules`；
   并检查 rollup/esbuild 全平台二进制是否齐全（规避 npm optional deps 缺陷 npm/cli#4828）。
3. **安装**：`npm ci` 严格按清单安装；结束后做独立完整性校验
   （npm 存在崩溃却返回 0 的情况，故不只信退出码），失败会列出**具体卡在哪个包**。
4. **安装后复核**：每个顶层依赖的实际版本必须与清单逐字一致。
5. **结果落盘**：写入 `frontend/.deps/install-report.json`（本地保留、不入库），
   完整日志写入 `frontend/logs/deps-<时间戳>.log`，重启后可用 `npm run deps:report` 查询。

不一致时日志以 `[MISMATCH]` 标注环境/版本差异，以 `[ERROR]` 标注失败步骤与原因。

### 日常添加 / 升级依赖

```bash
npm install <pkg>            # 改动 package.json 与 package-lock.json
npm run deps:verify          # 提交前确认清单与安装一致
git add package.json package-lock.json   # 两份必须一起提交
```

