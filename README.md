# MedClaw

<p align="center">
  <strong>面向医疗器械数据的本地桌面问数工作台</strong><br />
  用自然语言提出问题，让查询、计算与回答都有可核查的依据。
</p>

<p align="center">
  <a href="docs/spec/00_MedClaw完整产品方案_v1.md">产品方案</a> ·
  <a href="docs/spec/01_MedClaw_P1_Provider与桌面基础_目标方案_v1.md">当前阶段设计</a> ·
  <a href="docs/plans/2026-09-30-medclaw-p1-provider-desktop.md">实施与验收记录</a>
</p>

## 我们的产品

MedClaw 面向已有结构化医疗器械数据的分析与核查工作。产品目标是把文件导入、条件理解、筛选统计、批次比较、连续追问、依据查看和导出连接起来：程序负责确定性查询与计算，模型负责理解问题、选择取证步骤和解释结果。

项目按阶段建设。目前已实现 **P1「Provider 与桌面基础」的工程功能**：配置模型、发起单轮文本请求、停止生成、保存并核查运行事实。医疗器械数据导入、Agent 工具和多轮会话属于后续阶段，尚未接入当前应用。

运行记录与配置保存在本机；使用外部模型时，本次请求文本会发送到所选供应商。当前的 **Chat** 页面用于验证模型调用链路，每次请求独立发送此次文本；左侧功能栏统一使用英文。

## 核心功能

### 模型目录与接入

- Models 页面动态读取 Pi 提供的供应商与模型目录，支持搜索、供应商筛选和手动刷新。
- 展示模型输入能力、上下文窗口、输出上限与能力来源；浏览目录无需先完成认证。
- 按供应商实际支持的方式使用 API Key、OAuth 或环境／系统身份，支持认证取消与状态查回。
- 刷新失败保留已有目录并呈现错误；模型出现在目录中不代表已经通过真实请求验证。

### 自定义供应商与模型

- 登记供应商地址、Pi 支持的原生 API、模型标识和能力，通过 Pi 原生注册接点装配。
- 自定义输出上限需要明确声明并校验；缺少可信上限时阻止发送。
- 支持定义更新、模型选择发布，以及重启后的重新装配。
- 活动请求冻结当次模型与政策，后续配置变更不改写正在执行的请求。

### 单轮调用与停止

- 输入文本后发送，临时流式展示生成结果；Enter 发送，Shift+Enter 换行。
- 输入区可直接下拉选择已配置的内置或自定义模型；切换保留草稿，对下次发送生效。
- 输入与回复的角色标签分别为 **User** 和 **Assistant**；所选模型在模型选择区展示，Run 与模型事实在运行详情中查看。
- 点击 **停止生成** 协调 SDK 中止，并分别确认执行停止与必要记录保存。
- 供应商协议、响应解析、流式事件和模型重试复用 Pi；产品不叠加模型请求重试。
- 总期限不会随原生重试续期；保存失败时可重试保存原事实，不重复发起模型请求。

### 运行核查与设置

- SQLite 分别保存 Provider Run 与真实逻辑模型调用摘要，支持读取历史运行与分页读取结果。
- 运行详情展示模型、冻结条件、状态、SDK 停止原因、用量及安全错误。
- 未取得的 Token、费用和 HTTP 尝试信息保持未知；SDK 费用估算不作为供应商账单。
- Settings 支持请求政策、显示偏好、显式配置回退、Host 控制及安全诊断。
- 重启后可查回已保存摘要，不自动重发未知请求，也不把摘要读取当成完整会话恢复。

## 工作原理

```text
React 桌面界面
      │ 白名单公共端口
      ▼
Preload → Electron Main
                │ 受控 JSONL / 凭据交接
                ▼
             Bun Host
                │
                ▼
            Application
          ┌─────┴──────┐
          ▼            ▼
      runtime-pi    storage
          │            │
          ▼            ▼
       Pi SDK       SQLite
          │
          ▼
       模型供应商
```

Main 启动并管理自有 Host，发布非秘密配置，保护凭据。Host 是数据根中 SQLite 的唯一写者，协调请求、取消和记录提交。`runtime-pi` 负责必要的边界适配，模型运行机制交给 Pi。`logging` 提供有界诊断与安全投影。

### 技术栈

| 层次 | 当前实现 |
| --- | --- |
| 桌面 | Electron、React、TypeScript |
| 工作区与 Host | Bun workspaces、受控 Bun 子进程 |
| 模型运行 | Pi SDK，固定 `0.87.1` |
| 存储 | `bun:sqlite`，P1 的迁移、Run 和模型调用三表 |
| 契约与校验 | TypeScript、Zod、白名单 IPC／Host 协议 |
| 工程验证 | Bun Test、Playwright Electron E2E |

## 快速开始

### 启动开发桌面

当前提供源码开发运行入口，尚未交付安装包。使用 Windows 开发环境，准备 Bun `1.4.0` 与 Node.js 24；Node.js 用于 Playwright 等工程检查。

在项目根目录运行：

```powershell
bun install --frozen-lockfile
bun run dev:desktop
```

开发命令会构建桌面入口、启动 Electron，并由 Main 启动自有 Bun Host。关闭窗口或在启动终端按 Ctrl+C 会请求应用退出；重新启动会读取同一开发数据根。

### 配置与使用模型

1. 打开 **Models**，搜索并选择供应商和模型。
2. 按页面提供的实际方式完成认证。API Key 在应用认证界面输入，不写入源码或 README。
3. 点击 **发布模型选择**。可使用 **验证已发布模型连接** 发起独立的诊断请求。
4. 进入 **Chat**，输入此次文本并发送；生成期间可点击 **停止生成**。
5. 打开 **查看运行详情**，核查结果、保存状态与调用事实。
6. 如需接入自定义服务，在 Models 新建定义，填写地址、原生 API、模型与实际能力，保存后选择并发布。

已有有效配置会在重启后读取，无需每次重新输入凭据。目录可读、认证可用、配置已发布和实际调用成功是分别核验的状态。

### 使用隔离数据根

默认开发数据保存在项目的 `.medclaw-dev/`，构建产物位于 `.build/desktop/`。希望试验另一套配置时，可指定独立目录：

```powershell
bun run dev:desktop --data-root D:\medclaw-sandbox
```

每个数据根只允许一个受控 Host。运行数据含请求文本与结果，分享调试信息时不要直接上传整个数据根。

## 工程命令

| 命令 | 用途 |
| --- | --- |
| `bun install --frozen-lockfile` | 按锁文件安装工作区依赖 |
| `bun run dev:desktop` | 构建并启动开发桌面和受控 Host |
| `bun run typecheck` | 检查当前工作区 TypeScript 类型 |
| `bun run test:unit -- --stage P1` | 运行 P1 单元检查 |
| `bun run test:integration -- --stage P1` | 运行 P1 跨模块、Host、存储与工具链检查 |
| `bun run test:e2e -- --stage P1` | 在真实 Electron 中运行 P1 桌面检查 |

`--stage P1` 由项目的 `tests/run.ts` 消费。阶段报告包含测试发现数、执行数、通过、失败与跳过；零执行不能通过。目前没有独立的安装包或发布脚本。

## 安全与产品边界

- Renderer 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，通过 Preload 白名单端口操作产品。
- 凭据由 Main 使用 Electron `safeStorage` 加密保存；已存秘密不返回 Renderer，也不写入普通诊断。
- Host 与 Main 通过私有受控通道交接必要凭据；Renderer 无任意文件、SQL 或进程执行入口。
- 非秘密 settings、加密凭据与 SQLite 分别管理，部分失败通过状态查回和明确恢复处理，不假装属于同一个事务。
- 请求输入与输出会持久化到本机运行记录；临时流式增量不是可续接的持久事件日志。
- P1 不注册 Agent 工具、不创建 AgentSession，不承诺医疗器械问数质量、完整历史恢复或供应商后台计费停止。

## 项目状态

截至 **2026-10-01**，P1 桌面与 Provider 工程功能已经实现。当前开发环境中，用户配置的 DeepSeek 已有真实诊断、单轮成功与 Stop 保存后查回的证据。

实施记录中的最近工程门禁为：类型检查通过，单元 **24** 项、集成 **77** 项、Electron E2E **9** 项通过，均无失败或跳过。完整执行范围、日期与证据边界见 [P1 实施计划](docs/plans/2026-09-30-medclaw-p1-provider-desktop.md)。

P1 整体退出验收仍有专项证据待补，包括自定义服务真实目标更新与重启、一次实际服务明确失败及指定 Windows 系统缩放档位。这些是验收覆盖项，**不表示当前已配置的模型不可用，也不要求重复配置有效模型**。工程夹具结果与真实服务结果分别记录。

## 路线图

后续阶段以 [完整产品方案](docs/spec/00_MedClaw完整产品方案_v1.md) 为准，以下能力尚未作为当前桌面成果交付：

- **P2–P6：** 原生 Agent Loop、多 Session、受控工具与数据导入、消息投影、输入控制和持久事件补读。
- **P7–P10：** 工作区选择、上下文交付、完整原生历史保存与恢复、原生上下文压缩。
- **P11–P13：** Prompt／Skills、受信扩展和受限子 Agent。
- **P14–P15：** 意图识别、查询路由、统计比较与趋势、依据和导出闭环。
- **独立评测→P16–P17：** 必要产品能力就绪后，先完成数据/必要工程、本地评测、已有结果平台验收三阶段；P16复用模块接桌面，P17验证安装、资源与Host。当前P15固定官方0.8B语义门槛及T10/T11未关闭，完整基线仍未就绪。

## 文档

- [完整产品方案](docs/spec/00_MedClaw完整产品方案_v1.md)：业务目标、阶段边界、公共契约与技术路线。
- [P1 目标方案](docs/spec/01_MedClaw_P1_Provider与桌面基础_目标方案_v1.md)：Provider、桌面、状态、持久化和验收设计。
- [P1 实施计划](docs/plans/2026-09-30-medclaw-p1-provider-desktop.md)：开发任务、实际执行记录与手工验收步骤。
- [数据输入文档计划](docs/plans/2026-09-30-agent-data-input-docs.md)：离线数据与产品输入的说明组织。
- [Agent 评测总方案](docs/evals/01_MedClaw_Agent评测总方案_v1.md)：后续独立评测设计与证据边界。

## 参与开发

修改前先确认所属阶段与实际入口，复用既有契约和 Pi 原生能力。当前工作区按职责划分如下：

```text
apps/desktop/       桌面 Main、Preload 与 React 界面
apps/host/          受控 Bun Host 入口
packages/contracts/ 公共类型、校验与通信协议
packages/core/      Application 协调
packages/runtime-pi/ Pi 适配、凭据桥与调用摘要
packages/storage/   SQLite 迁移与仓储
packages/logging/   有界诊断与安全投影
tests/              单元、集成与 Electron E2E
docs/               产品设计、计划及评测方案
```

提交改动前运行相应工程命令，涉及边界、取消或保存行为时补充可运行的回归检查。桌面交互调整附实际窗口验证；真实服务检查只使用本人可用配置，报告中保留未知与未验证条件，不提交密钥或运行数据。

评测规范与操作入口：

- [01评测总方案](docs/evals/01_MedClaw_Agent评测总方案_v1.md)、[02数据制作方案](docs/evals/02_MedClaw_Agent评测数据集制作方案_v1.md)、[03平台设计](docs/evals/03_MedClaw_Langfuse平台接入设计方案_v1.md)。
- [05三阶段实施总手册](docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md)：唯一实施计划，附录A集中必要工程。
- [06纯数据制作手册](docs/evals/06_MedClaw_Agent评测数据集制作实施与操作手册_v1.md)：只制作Case/Gold、材料和审核交付。
- [07用户本地执行](docs/evals/07_MedClaw_Agent本地评测执行操作手册_v1.md)、[08平台接入与结果验收](docs/evals/08_MedClaw_Langfuse接入与评测结果验收手册_v1.md)。

2026-10-12本轮仅修订文档；评测目录/命令尚未实现，不执行正式数据制作、模型评测或平台上传。目标命令须经工程交付后再标可执行。
