# MedClaw Agent 评测 v1

只读预检与故障定位：`bun run eval:smoke -- --check` 和 `bun run eval:full -- --check` 检查当前文件、配置和计划。共享 fixtures 使用 UTF-8 文本，由 `.gitattributes` 固定 LF 换行，Windows 检出也必须保持一致。入口以 `error=dataset_invalid` 和固定 `reason` 区分 `review_content_changed`（实际材料或数据与核验记录不一致）及 `review_criteria_changed`（判据与核验记录不一致），均返回非零。先检查 `git ls-files --eol agent-eval/src/fixtures`；确认只是 CRLF/LF 差异时恢复文件换行，真实内容变化则重新独立核验。运行时保持原始内容核对，不自动改写文件或审核状态。本次修复与实际验证见 [05 附录 B.14](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#eval-smoke-fixture-lf-v1)。

B.14 换行修复验证：typecheck 通过，评测工程测试 268 通过、0 失败；Python 普通与 `-O` 各通过 67,494 项检查。Smoke/Full 只读预检及不同工作目录加载均退出 0，分别生成 10/150 个计划 Trial；没有执行真实评测或平台上传。

`ready=true` 表示只读预检通过，执行阶段仍可能失败。启动异常会安全输出 `validation_error` 的字段路径及类型、`filesystem_error` 的固定错误码及操作，或 `location` 中现有评测源文件的位置；不输出配置值、私有文件路径、异常原文或完整堆栈。若预检后失败，请保留这条 JSON，按具体错误继续定位，不能将预检通过当作实际执行通过。

2026-10-14 用户已执行真实 Smoke `smoke-20261013T165746254Z-209638e0`，原始结果为 0 PASS、4 FAIL、6 UNJUDGEABLE，Judge 实际调用 0 次。采证显示 9 次主模型 HTTP 404、3 次意图识别超时；原报告保留。已修正主模型协议及 Judge SDK 接入，当前修复仅用本地受控服务验证，尚未真实复测；下方各历史批次的 NOT_RUN 状态只适用于当时。

本次 SDK 接入修复的最终工程验证为 283 通过、0 失败，类型检查、Python 普通/`-O`、数据引用与 Smoke/Full 只读预检均通过，实际结果见 05 附录 B.16。原报告独立读回及 352 个历史归档文件保持不变；3 次意图超时的根因未关闭。

B.15 诊断补齐验证：typecheck 通过，完整评测工程测试 274 通过、0 失败；覆盖正常执行入口的受控启动失败，以及取消状态下原生 Runner 的 10 题归档与读回。该次用户实际启动异常尚未复现，待原窗口的新错误 JSON 确认根因。

> 终端 E2E 修复结果见 [05 附录 B.13](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#e2e-report-diagnostics-v1)：最终 18 个文件、200 项全部通过，0 失败、0 跳过，退出 0，报告完整。已修复带颜色汇总的解析、报告目录与保存、P11 子进程汇总误判，并补齐 Host 失败诊断。工程原始日志与汇总保存在 `test-results/.runs/<run-id>/`；最新汇总为 `test-results/e2e-results.json`。用户原 199／1、首次修复验证 198／2 和中断记录均保留，Host 原偶发故障根因仍未确认，生产状态机未改。

> 2026-10-13 本次实施规则：本地 Smoke 为 10×1，Full 为 50×3；两者直接执行并保存当次快照，上传已有报告使用独立命令。配置不要求人工就绪声明或手填源码清单，源码由控制器自动记录。Judge 校准可独立执行，不是运行前提。本批只进行受控工程验证，真实 Agent/Judge、Smoke/Full 与平台上传仍为 NOT_RUN。数据与本地执行链交付见 05 附录 B.11；默认终端 E2E 入口及验证见 B.12。

```powershell
bun run test:e2e
bun run eval:smoke
bun run eval:full
bun run eval:upload -- --execution-id EXECUTION_ID
```

`test:e2e`默认用Bun在终端执行真实Host、SDK、工具、SQLite和产物工作流，使用受控本地模型服务，不启动Electron或浏览器。复用tests/integration的Host用例，以及P4消息和P15问数/纠正/导出工作流；`bun run test:e2e:desktop`单独保留桌面UI覆盖。两种工程入口支持`--stage Pn`和`--check`，终端和桌面结果分开保存。Smoke为10×1，Full为50×3，适用语义检查使用独立Judge；本地保存后显式上传。检查模式不启动产品或模型、不联网、不创建执行/导出文件；退出0表示检查或执行通过，1表示参数/配置/设施/传输错误，2表示准入或质量未通过。

快捷命令按入口文件位置显式读取 `agent-eval/configs/agent.json` 与 `configs/environment`，以 `node:util.parseEnv` 解析中文注释、引号和空行。受管理变量以文件为准，不由同名 Shell 值补齐/覆盖，不修改全局环境。主模型仍只填写 url/key/model，Judge 仅填写 BASE_URL/MODEL/API_KEY 三项；上传仅读取平台配置和指定归档。旧显式 CLI 保留，不增加任意 .env 自动加载；密钥不进入 Agent、快照或日志。

Judge 不受确定性高低分触发。独立 MEDCLAW_JUDGE_*，初始温度 0.8、超时 30 秒；每个适用 Trial 最多一次，不自动重试、不切模型、不继承 Agent 密钥。不设置人为输出 Token 上限或整次输出预算，沿用服务端和模型限制。请求数和 Trial 身份仍按计划校验；Agent、意图、压缩、子执行和 Judge 的实际用量分别记录，未知值不填零，不能推算固定费用上界。Case.maxToolCalls、资源预算和采证分页限制继续保留。

Judge 通过 Pi SDK 0.87.1 的独立 Provider 调用，和主模型共用离线原生模型解析；不再手工拼接 `/chat/completions`。URL 与模型原生协议匹配，官方 DeepSeek `/anthropic` 使用 Messages 协议。环境仍只有三项配置，不填写额外 provider 或 Token 限制。SDK 在协议需要时自动发送原生模型上限，应用不设置 `maxTokens`；这是原生能力，不是已删除的 256 Token 或总输出预算。`snapshot.config.judge.nativeModel` 与调用元数据记录目录引用、API、原生输入/输出能力和 SDK 版本，Key 仅传独立 Judge。旧归档不补填这些字段，新旧配置差异仍被比较识别。

DeepSeek 官方仍接受旧名 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp`，实际由 Flash 服务。本项目仅对官方域名按这项已公布映射读取 `deepseek/deepseek-flash` 的原生能力，保留配置和请求中的旧名；不会对任意未知模型或第三方代理猜测映射。[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)、[Anthropic 接口说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

Smoke 与 Full 直接从当前制作来源加载，并在执行前保存当次 snapshot.json；Full 首次即可运行，不要求历史 Smoke 成绩或 Judge 校准。Baseline 是用户选择的一次本地执行报告，失败和未运行成员也保留。配置、依赖、数据引用和实际协议继续检查；校准是可选独立工具。

第一阶段已有方案、功能实现、50个短Case、10个Smoke引用及数据审核。本批直接本地执行与完整E2E修复的实际结果见[05附录B.11](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#local-eval-repair-v1)。B.10的106通过、17失败、30未运行是修复前历史结果。真实 Agent、Judge、Smoke、Full、平台上传均为 **NOT_RUN**。工程测试和数据核对通过，不代表 Agent 质量通过。

Case 参考 Folio 的 `packages/core/src/evaluation.ts` 和 `packages/shared/src/evaluation/datasets/folio-agent-v1.ts`，普通声明为约 20–40 行，并按 11 类 Harness 连续分组注释。唯一制作入口是 [medclaw-agent-v1.ts](src/datasets/medclaw-agent-v1.ts)，不生成逐题 JSON。数据集公共信息保存业务日期、时区、评分版本、审核策略及 Smoke ID。

| 六项标准 | 声明位置 |
| --- | --- |
| 用户输入 | `input.prompt`，必要时补充 `input.turns` |
| 初始环境 | `input.workspaceContext` 的逻辑页面、地区、器械选择，以及 `input.fixture.ref` |
| 成功标准 | `expectedFacts` 或 `goldRef`、回答要点、必要能力和依据要求 |
| 失败标准 | `forbiddenConditions`、禁止能力及公共安全硬约束 |
| 评分方式 | `scorers` 引用 Registry 的方法、维度、单位、阈值和硬约束 |
| 风险点 | `risks`；没有相关风险时显式 `[]` |

所有 Case 名称、实际用户输入、后续输入、回答要点和失败条件使用英文，业务字面值与共享资料保持一致。合法空结果采用可表达的类别过滤；缺失日期按`query.coverage`核对完整目录和登记导入原文，并由语义评分判断缺失说明，不要求不存在的成功Query。零适用数值分母保留原始0及不适用状态。集中审核绑定公共info、Smoke成员及全部Case、Gold和fixtures，任何变化都必须重新核验。沿用 Folio 的 id/name/category/difficulty/input/expected/tags/source；扩展独立的 `evalType`、多轮输入、结构化事实、Scorer 引用和风险标签。简单事实直接声明，复杂计算、集合及来源要求集中在 [Gold](src/datasets/medclaw-agent-v1.gold.ts)，同一事实只定义一次。

保留 Folio 的 `id/name/category/difficulty/input/expected/tags/source`；`evalType` 仅取 capability/regression，不另建 purpose 重复字段。50题均必填 `sourceRef`，解析到集中 `sourceReferences` 中真实的产品规范或实际 issue，分别说明能力依据与题目制作来源；当前真值仍为 hand-authored 合成资料、developer_visible，不伪造历史 bug、医院事实或真实运行轨迹。

50题均必填 `maxToolCalls` 与 `mustHaveEvidence`。预算是包含0的非负安全整数；逐题审核按“必要业务动作＋必要核验＋有依据的恢复余量→最终上限”记录理由，不能统一套用默认值。证据要求同样逐题说明哪些业务事实、资源、历史或产物必须可追溯，以及允许无业务Query的理由。既有50个互不相同且由Judge消费的 `expectedAnswerHint` 保留，并逐题检查具体对象、条件、结果与缺失边界；`forbiddenConditions` 每题写1–3项可观察失败，映射实际检查，不重复通用口号。

`requiredCapabilities` 只列任务不可缺的真实调用，其成功由结果与专门检查另判；`optionalCapabilities` 不是白名单，未列辅助调用仍按任务、预算和授权核验。`forbiddenCapabilities` 仅表示整个Trial始终禁止的能力；“仅经确认才可导出/写入”等条件授权放在专门Scorer里核验，不能先全程禁止再在后一步放行。`workspaceContext` 只保留 activeView/region/device 等逻辑现场，不新增当前不存在的 environment；实际实例、数据库、模型和Session身份由Executor创建、采集和记录。事实只定义一次，合法空结果可以有充分证据。

GoldDefinition 在集中真值模块增加强类型 `scorerExpectations`：键仅来自已注册Scorer ID，每个键对应该Scorer的具体预期类型，未知键或形状拒绝；不能用任意 `Record<string, unknown>` 绕过，也不在 Case.expected 再复制一份 harness 对象。Case的 scorers 选择检查，Gold提供该题差异预期，Registry公共硬约束保持唯一来源。

结构化 `target/facts` 是对象、日期、集合、数值等事实的规范来源；评分预期复用这些事实和逻辑alias，执行后解析实际Run/Session/Query/operation身份。Gold同时声明 `expectedSources`、`evidenceRequirements` 和明确 pass/partial/fail 的 `rubric`；语义检查只把选中且适用的要求交给同一次Judge。Case预期只能细化任务，不能覆盖安全、真实停止、必要保存或基础设施硬约束。

| Harness 主类别 | Case 数 | Smoke 数 |
| --- | ---: | ---: |
| task | 6 | 1 |
| tool | 6 | 1 |
| skill | 4 | 1 |
| resource | 4 | 1 |
| context | 5 | 1 |
| memory | 4 | 1 |
| compaction | 4 | 1 |
| subagent | 4 | 1 |
| intent | 5 | 1 |
| security | 5 | 1 |
| export | 3 | 0 |
| 合计 | 50 | 10 |

`difficulty` 沿用 Folio 的六类标签；`evalType=capability/regression` 单独声明，业务场景和次要功能放 tags。Smoke 只是 ID 子集，不是复制数据，也不构成盲测留出。

```text
agent-eval/
├─ README.md
├─ configs/{agent.example.json,environment.example}
├─ scripts/{export-data.ts,record-data-checks.ts,verify-stage-one.py}
├─ src/
│  ├─ presets.ts                       # 固定配置、快捷模式与只读预检
│  ├─ evaluation.ts                    # Case、Gold 和数据契约
│  ├─ datasets.ts                      # 加载、快照读回和输入投影
│  ├─ dataset-compiler.ts              # 公共检查与注册动作组合
│  ├─ dataset-fixtures.ts              # 共享文件读取、转换和初态准备
│  ├─ data-format.ts / independent-gold.ts
│  ├─ datasets/
│  │  ├─ medclaw-agent-v1.ts
│  │  ├─ medclaw-agent-v1.gold.ts
│  │  └─ medclaw-agent-v1.review.json
│  ├─ fixtures/
│  │  ├─ README.md
│  │  ├─ medclaw-agent-v1.fixtures.json
│  │  ├─ procurement.csv
│  │  ├─ source-audit.md / source-audit-injected.md
│  │  ├─ resource-index.json / source-note.md
│  │  └─ privacy-canary.txt
│  ├─ execution/{runner.ts,trial.ts,observe.ts,instance.ts}
│  ├─ scoring/                         # Registry、判据、Judge 和校准
│  ├─ adapters/ / reports/ / review/ / langfuse/
├─ tests/
└─ runs/<execution-id>/
   ├─ snapshot.json
   ├─ report.json
   ├─ evidence/<trial-id>/
   │  ├─ trial.json / observation.json / events.jsonl
   │  └─ artifacts/                    # 有实际产物时保存
   ├─ review.json                      # 有真实反馈时保存
   └─ export.json                      # 有实际导出时保存
```

snapshot 保存实际 Case、Gold、sourceReferences、fixtures、产品资源正文、审核、配置、编译checks/Gold/Rubric和源代码内容；report 合并计划、Trial 状态、分数和汇总，引用完整采证。Trial 文件合并所有权、隔离、启动、停止及清理证明。产物使用相对路径和实际内容核对，读取归档只读记录JSON，不执行TS，不由当前编译器重算或覆盖旧规则。校准采用同样的 snapshot/report/evidence 模式。可选校准使用相同归档模式。

每个 Trial 都保存 `events.jsonl`，未启动时为空；读回拒绝缺少日志、无效记录或 Judge 调用与日志不一致的归档。Judge 只在 `configs/environment` 填写 `MEDCLAW_JUDGE_BASE_URL`、`MEDCLAW_JUDGE_MODEL` 和 `MEDCLAW_JUDGE_API_KEY`，快捷入口显式读取该文件并以文件值为准，不用同名Shell值补齐/覆盖；旧低层CLI仍显式接收调用环境。`agent.json`、示例及其他 `--config` 输入不含 `judge`，出现该字段会被拒绝。运行与记录从这三项环境变量自动生成 `snapshot.config.judge`，保存端点、模型、超时、温度、系统 Rubric 和 SDK 原生能力 nativeModel，不保存 API Key。校准、Smoke、记录、Full 和比较继续核对实际公开配置；读取旧归档使用归档中的配置，不依赖当前环境变量。

被测主模型独立配置在 `configs/agent.json`，`model` 只接受 `url`、`key`、`model` 三项。`url` 填与模型原生 API 协议兼容的服务地址；`model` 精确匹配 Pi SDK 0.87.1 的原生模型目录，支持唯一的模型 ID，有同名项时用 `provider/modelId` 消除歧义（例如 `openai/gpt-4o-mini`，实际请求仍使用 `gpt-4o-mini`）。输入 contextWindow 和输出 maxTokens 均由原生目录解析，不填写 provider、maxTokens 或 contextWindow，不另设评测输出上限；目录缺失或歧义在预检拒绝，不猜测能力。运行时通过产品已有自定义 Provider 入口装载公开端点和原生能力，通过私有凭据通道只提供对应 Provider 的 API Key。快照只保存解析后的公开配置和原生上限；`agent.json` 含密钥，已加入 Git 忽略，不复制到报告或 Trial 工作区。本地原生工具使用当前 Windows 账户权限。Runner 创建独立临时工作区，只向 Host 提供必要环境与公开材料，不把 Gold、Hint、未来输入、审核和 Judge/Langfuse 密钥作为 Agent 输入。独立目录不构成系统权限沙箱；采证核对实际泄漏、所有权、停止和保存，不生成 OS 隔离通过结论。

评测自有版本始终 **v1**，必要数值版本固定 **1**，不保存哈希、摘要 ID 或修订号。比较核对实际数据、判据、来源及配置内容。平台 ID 随机生成一次并在 export.json 中复用，反馈和补传不重跑评测。产品协议要求的校验仅在适配器及临时导入文件中执行；归档移除这些字段，保留实际内容、对象身份和引用。源代码投影明确排除产品构建摘要声明；归档不提供密码学防篡改证明。

结果、过程、安全分别评分，基础设施作为准入门槛。可程序判断的事实、单位、集合、日期网格、参数、能力和调用预算使用确定性检查；开放回答及实际采用交给有明确 Rubric 的 Judge。公共reviewPolicy派生report.reviewCandidates：隐私/资金/删除/外发/提示注入等高风险或实际违规、Judge partial/null、真实争议；permission单标签不自动入选。completedReviewRequired:false。第三阶段review enqueue只入选这些候选；入队不等于已审核，review.json只在真实反馈后创建，反馈不覆盖自动分数。公共组合不限制完整调用顺序，也不把可选能力当白名单。

保留 PASS / FAIL / UNJUDGEABLE / ERROR / NOT_RUN 及原始分母，按三维、Harness 和评测用途汇总。`task.success` 只派生业务结果；过程或安全硬失败仍使整体失败，不能被结果分数抵消。缺失证据不算成功，合法空结果可以有充分证据；0、缺失价、缺日期和错误单位分别检查。

材料为显式虚构的采购业务：24 行、浙江和河南共 6 个器械、4 个快照日期，9 月 30 日无快照；金额为整数分，0 与 null 分开。名称、厂家、配送商和价格不声称来自医院、官方或真实经营数据。许可 CC0-1.0，所有题目属于同一 `developer_visible` 合成来源组，没有真实轨迹或未曝光盲测的声明。source-audit仍为公开核验材料；4个Skill题改用query-skill，真实选择resources/skills/query/v1/SKILL.md及references/facts-and-assumptions.md，不再引用不存在的synthetic-source-audit/v1。未使用的 history fixture 与说明文件已移除；每题的 `input.prompt/turns` 通过注册动作建立真实历史，不伪造 SDK 历史文件。

[独立 TS 计算](src/independent-gold.ts) 与 [Python CSV/Decimal 核验](scripts/verify-stage-one.py) 不读取产品 Query/Diff 结果作为真值。集中 [review.json](src/datasets/medclaw-agent-v1.review.json) 保存核对方法、人员/程序身份、时间和实际被核对内容；内容变化后旧审核失效。Agent 只接收当前 prompt、业务日期、允许材料和产品上下文，不接收 Gold、审核、评分规则或未来步骤。

11类功能都用真实专门证据核验，不能仅凭通用Query正确率或存在一个注册名宣称覆盖：

| 功能 | 专门检查所需内容 |
|---|---|
| Task | 独立业务终点、完成声明和澄清/停止决策；结果与过程分别汇总 |
| Tool | 原模型参数及最终参数、必要/冗余调用、实际错误、有限重试和恢复依据 |
| Skill | 真实query/v1选择、SKILL/参考正文读取与交付、适用规则遵循；禁止调用对照 |
| Resource | 真实资源ref、版本/实际字节、模型读取及由资源影响的后续动作 |
| Context | 最新有效纠正、已撤回条件清除和当前事实的实际采用 |
| Memory | 原Session/可达分支、来源回合、应保留/清除事实及后续使用 |
| Compaction | 真实压缩边界、保留事实与来源、保存及续问结果 |
| Subagent | 父子身份/只读范围、独立子结果、父采用、取消与真实停止 |
| Intent | classify/verify原预测、程序route/status/query kind及最终采用分开核验 |
| Security | 条件授权、真实路径/公开投影与秘密边界、注入指令和实际动作 |
| Export | format、sourceQuery身份、列集合与真实文件内容/范围，不仅检查文件存在 |

以上映射细化当前23项Harness行为及业务、安全、导出指标；原公式、机会单位、原始分母和附录原61项不改写。

`tool.params` 使用确定性检查核验原参数、Schema、对象/日期/范围及依赖，和 `answer.faithful` 等语义检查分开。Judge只消费选中且适用的语义要求；参数或持久事实缺证据不能由Judge补判正确。

公共 `query.list` 仍只读取当前active Workspace Session。控制器采证使用既有私有 `controller.evidence.read` 的 `kind:'queries'` 选择器，先盘点全部真实root/child Runs，再按run/session/ownerInstance身份绑定的queryIds读回实际Query/Evidence。该选择器只读SQLite并复用原分页协议，不切换Session、不放宽公共查询权限，也不向Agent增加工具或可见数据。

Tool、child Run和Query清单分别保存采证完整性；空清单只有完成分页、身份核对与真实零成员事实才是合法0。任何清单缺页、关联缺失或采集失败都保留EvidenceGap，相应检查为UNJUDGEABLE或明确设施ERROR；不能因“没看到调用/子任务/Query”就使预算、授权、Scope或安全检查PASS。

快照绑定实际Case/Gold、来源、资源正文、编译checks、criteria/Rubric、配置与逐题authoring审核内容；内容变化使旧审核失效。报告读回的聚合使用记录的指标维度和判据，不由当前Registry重新解释旧结果。归档加载只用于只读校验/展示/比较，archive-only Dataset不能重新执行；需要新Execution时重新从当前制作来源加载并满足对应准入。

`review setup`返回实际队列回执；尚无反馈时，平台队列身份和回执保存在 `export.json.review`，有真实反馈后随 `review.json` 的复核状态保存；enqueue处理原report.reviewCandidates和真实反馈派生的争议候选。同一队列允许后续真实争议形成的候选按append-only union追加；固定trial→trace映射，拒绝remap，重复补传先GET去重，仅发送尚未入队成员。未提交实际反馈时不创建review.json。实际反馈或其来源/内容冲突才写review.json，冲突保留并提示处理，不修改自动分数；补传复用原平台稳定ID，不重跑或重评分。

本阶段可执行的检查：

```powershell
bun run typecheck
bun run test:eval
python -X utf8 agent-eval/scripts/verify-stage-one.py
python -X utf8 -O agent-eval/scripts/verify-stage-one.py
bun run eval -- dataset validate --dataset medclaw-agent-v1
bun run eval -- dataset audit-lineage --dataset medclaw-agent-v1
bun run eval -- doctor
```

该历史批次 `doctor`实际退出1、ready=false：OS Gold 隔离、P15 真实语义就绪门槛尚未关闭，仓库声明的 subagent patch 文件缺失。当时未启动质量运行；当前规则见 B.11。测试使用回环受控服务，验证真实本地 Host 的确定性查询、导出、分页、恢复与停止，不调用 Agent 或 Judge 模型。30 秒停止超时测试按设计保留故障证明。

第二阶段才执行独立 Judge 校准、10×1 Smoke、当次记录和 50×3 Full；平台接入验收属于第三阶段。配置示例不含凭据，明确从控制端环境读取 Judge/平台密钥，不隐式加载任意 .env（快捷入口显式读取固定 environment），不继承到产品子进程。旧 150 文件数据已在替换前保存在忽略目录 `.superpowers/sdd/medclaw-eval-v1/backup-20261013-015345/`。

Judge配置去重后的本批受控验证见[05附录B.8](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#judge-environment-only-v1)：类型检查通过，完整工程套件242 pass/0 fail（38文件、1,417项expect、75.10秒）。仅环境中的三项变量作为Judge输入，运行/记录自动归档不含密钥的实际配置；用户已填写值保留，真实质量状态仍NOT_RUN。

独立主模型配置的本批验证见[05附录B.9](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#agent-model-connection-v1)：类型检查通过，完整工程套件249 pass/0 fail（39文件、1,457项expect、71.97秒）。三字段输入、原生能力、私有凭据、独立归档及端点比较均有受控检查，无真实推理、平台上传。

采用 Folio 的短声明、共享文件和独立加载：[fixture 加载器](D:/code/agent-learn/agent/folio/packages/longbridge-tools/src/testing/load-fixture.ts:14)、[来源及接口说明](D:/code/agent-learn/agent/folio/packages/longbridge-tools/src/testing/fixtures/README.md:3)。Folio 的真实 CLI 输出有采集命令记录；MedClaw 当前资料为显式合成来源，集中记录制作方法、许可和范围，不伪造真实采集。

| fixture.ref | 可复建初态 |
|---|---|
| procurement | 共享 CSV：浙江/河南、6 个器械、4 个快照日期、24 行，金额为整数分 |
| zj-only | 同一 CSV 的浙江范围，原始与导入公开材料均排除河南 |
| source-audit | 采购资料、核验规范与资源索引；属于输入指导资料，不冒称已安装产品 Skill |
| injected-guide | 采购资料、含恶意指令的核验文档与资源索引；攻击文本属于不可信数据 |
| missing-guide | 采购资料及明确缺失的旧版文档路径；准备后检查该路径确实不存在 |
| private-canary | 采购资料与公开来源提示；合成 canary 仅准备在控制器临时目录 private/credentials.txt |
| query-skill | 采购资料及真实产品 query/v1 Skill 的选择声明；正文从产品资源读取并随快照保存 |
| query-timeout-once | 采购资料；可信Host在每个Host首次获准查询前注入一次 tool_timeout，随后允许正常重试 |

`src/fixtures/medclaw-agent-v1.fixtures.json` 声明来源、范围和文件映射；正文保存在共享文件，加载和产品导入转换位于 `src/dataset-fixtures.ts`。原六个profile完整保留，新增的两个profile复用现有8个共享文件，不复制产品Skill正文到fixtures。资源 `resources/skills/query/v1/SKILL.md` 与 `references/facts-and-assumptions.md` 从产品读取一次并归档实际文本。文件引用必须校验允许名称、实际路径、符号链接和格式，未知引用拒绝。快照保存实际使用的声明及文件内容，归档读回不执行 TS，也不再读取当前工作区文件。

0、null、合法空结果和 9 月 30 日缺失快照分别保留。来源、单位和业务日期以实际资料为准，不推断未提供的现实原因。全部当前素材属于同一 developer_visible 合成来源组，没有未曝光盲测声明。

移除未参与执行的 history fixture 与历史说明 JSON。每题通过 `prompt/turns` 的真实注册动作建立历史、纠正、恢复和压缩，不伪造 SDK 历史。重试题 `mc-v1-tool-retry-transient` 使用 query-timeout-once：预算上限8、maxRetries=1，并以 `tool.failure_handling` 核验真实故障后的有界重试，不把两次成功查询冒充故障覆盖。公开输入不含 Gold、未来步骤、审核内容、评分代码或控制器 canary；canary 准备完成不证明 OS 隔离成立。

参考：[LangSmith Evaluation types](https://docs.langchain.com/langsmith/evaluation-types)、[Anthropic Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[OpenAI Graders](https://developers.openai.com/api/docs/guides/graders)。章节、操作和后续阶段见 [docs/evals](../docs/evals)。

2026-10-13前一批B.6交付（本次功能修订前的历史验证，非本次新通过记录）：根目录与agent-eval类型检查通过，评测工程测试193/193通过；Python普通和`-O`各19,876项核验通过，覆盖50题、62组阶段真值和24行源数据，核验脚本可从不同工作目录执行。Case含63次真实注册用户输入，声明24–31行。总方案恢复完整章节和附录、15篇外部资料及正文落点；全部本地链接和章节锚点可解析。详细实施位置、数据审核和阶段边界见[05附录B.6](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#b6-本次方案代码与数据修订2026-10-13)。

本次功能修订以[05附录B.7](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#functional-revision-v1)记录新增受控核验，不沿用B.6通过数。每题预算与证据依据、sourceRef、失败检查映射及强类型Gold预期重新内容审核。新select_resources动作在new_session之后、send之前，复用桌面MainSettings prepare/commit/abort；控制器索引读取不算Skill使用。可信HostHello的controlledToolFault只对query-timeout-once开放，每Host首个获准查询在业务效果前实际tool_timeout一次；重试题cap8/maxRetries1并检查tool.failure_handling。全部真实质量与平台运行仍NOT_RUN。

历史B.7实际核验：typecheck退出0；`bun --no-env-file test ./agent-eval/tests`为238 pass/0 fail（38文件、1,397项expect、65.44秒，delivery-engineering-tests-final.log）；包含真实本地Host资源/私有inventory/受控错误和local平台mock，真实模型调用0。Python普通和-O在verified记录上各67,644项检查退出0；最终审核时间2026-10-13T04:39:36.735893Z。50题25–33行、62阶段真值、24行源数据、100项不同失败、50sourceRef/11真实章节已核验；dataset validate在根目录与agent-eval cwd均退出0、readiness=reviewed，来源审计50 developerVisible/0 blind。最终独立审查无Critical/Important遗留问题；审核后的closeout/verification受控检查为6 PASS、29项assert。该批预检退出1保留OS隔离、P15和缺subagent补丁门禁，SDK0.87.1/patchPresent=false；这些多余前提及补丁缺失已在B.11处理，历史真实质量与平台保持NOT_RUN。


历史快捷入口与Judge输出限制清理见[05附录B.10](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#eval-presets-v1)：当时类型检查通过，评测工程套件260 pass/0 fail；完整桌面E2E为106通过、17失败、30 skipped/未运行，退出1，尚未全部通过。该批只读Smoke/Full预检返回准入退出2，受控归档上传预检退出0且未联网。用户配置值保持，真实质量和上传仍NOT_RUN；完整失败清单和实际命令记录在B.10，不借用历史通过数。

历史B.11已完成直接本地执行与完整E2E修复：类型检查退出0；完整unit/integration为1604通过/0失败（120文件），评测工程套件260通过/0失败（40文件、1,539项expect），当时`bun run test:e2e`执行桌面UI测试，为153执行/153通过/0失败/0跳过（24文件）；该覆盖现由`test:e2e:desktop`保留。截图用例两轮8项、P1/P7完整文件两轮56项均通过。Python普通与`-O`各67,494项核验通过并更新集中审核；50Case/62阶段真值/10Smoke/11Harness保持。精确Subagent补丁恢复后，干净`bun install --frozen-lockfile`安装143包并验证Pi0.87.1与managed接口。Smoke10×1、Full50×3及受控归档上传预检均退出0，不需要历史成绩或校准记录；上传检查不联网、不改变归档。实际配置仍被Git忽略，runs为空。完整命令、日志与历史失效证据说明见[05附录B.11](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#local-eval-repair-v1)。真实模型评测、真实Judge校准和平台上传仍为NOT_RUN。

本次终端入口调整见[05附录B.12](../docs/evals/05_MedClaw_Agent评测分阶段实施与操作手册_v1.md#terminal-e2e-v1)：`bun run test:e2e`实际执行18文件、200项全部通过，0失败、0跳过，475.88秒；进程采样未发现Electron。原24个桌面文件由`test:e2e:desktop`单独保留。类型检查退出0；完整单元及快捷入口检查为36文件、375通过/0失败。终端汇总/JUnit和桌面结果分开保存。本次使用本地受控服务，用户配置和数据集保持，真实质量及平台仍NOT_RUN。
