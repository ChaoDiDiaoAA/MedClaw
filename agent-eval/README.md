# MedClaw Agent 评测 v1

当前 Loader 只读取并核验当前 Case、Gold 与 authoring 内容；review.verifiedData 仅保留旧审核历史，不覆盖当前定义，也不作为隐藏的内容替换入口。独立来源、independentGold 或可复算记录缺失/不一致时保持 draft/pending；修改输入、真值、资源或判据后重新独立核验，旧运行快照和分数保留。

归档与数据准入状态： 用户已删除`agent-eval/runs`和`agent-eval/records`下的历史文件；历史来源保持删除状态，不补造替代原件或问题台账。下文旧执行ID、成绩及工程计数仅为历史记录，不能作为当前仍可读的原件。主集的数据准入以当前实际审核为准；专项仍保留3个声明成员，但共享判据变化且原issues与admission-evidence缺失，当前review为pending、执行准入阻断，不能沿用旧审核宣称已核验。

2026-10-14历史批次为`smoke-20261014T034659018Z-665ab02e`，原报告为0 PASS／6 FAIL／4 ERROR，原五态、分母按历史记载说明，证据已删除；设施影响未排除，质量结果尚未验收。完整节点诊断、共因、候选确认、修复和当时实际验证记于issues.md（历史引用，文件已由用户删除），不另建09运行报告。此前21项检查属于先前诊断，后文工程验证及NOT_RUN均保留各自历史语境，不能冒充当前通过或新的真实质量结果。

2026-10-14历史两次真实Smoke分别为3 PASS／7 FAIL和2 PASS／8 FAIL，均0 ERROR、10个Trial停止关闭、9次Judge完成；最新为`smoke-20261014T084155067Z-41942346`。首次Full`full-20261014T074335161Z-1e7c7f66`已完成50×3：20 PASS／120 FAIL／8 UNJUDGEABLE／2 ERROR，150项均停止关闭。Full后的控制器修复和中文／稳定标识／英文最小复现另记同一台账；正式Case、Gold和历史成绩保持。工程通过与真实质量分开，未宣称Agent质量通过。

附加专项集`medclaw-badcase-v1`（src/datasets/medclaw-badcase-v1.ts）已接入现有`run --dataset`：首批中文唯一实体、原英文意图及缺地区澄清3个成员，各重复3次；主集Full50×3／Smoke10×1不变。后两题原样复用Case／Gold。数据review记录实际独立CSV／Decimal核验，来源随可选caseOrigins／显式lineage冻结，不送入模型。稳定标识形式仍暂缓；专项用途不改变原Case的evalType或可靠性结论。制作见06_MedClaw_Agent评测数据集制作实施与操作手册_v1，Badcase专项制作、独立核验及成员登记，运行命令及显式环境读取见07_MedClaw_Agent本地评测执行操作手册_v1，1.1 Badcase附加专项执行与回归，首次实际基线及17项分流见同批issues。

专项制作记录包括candidates.json（历史引用，文件已由用户删除）、admission-evidence.json（历史引用，文件已由用户删除）及admission-verification.json（历史引用，文件已由用户删除）。这些私有材料不自动上传；首次专项是初始测量，后续实际复测才登记reruns.csv，实际诊断和优化曝光登记exposure.csv。成员或判据变化须重新审核、建立基线，专项与主集分别比较。

两份已删除核验JSON仅留历史记载；以后核验默认只读，实际审核录入经系统临时文件并在成功或失败后清理，不默认生成独立报告或verification目录。当前调整不追加真实专项、校准或平台操作。

首次专项`badcase-20261014T104507007Z-64011a61`已完成：0PASS／9FAIL／0ERROR／0NOT_RUN，9项全部停止关闭，实际9次意图请求、3次Judge正常返回。中文3次完成执行但目标实体或附加过滤判据失败，英文和缺地区各3次在意图JSON解析后被校验器拒绝。该失败基线及逐节点依据见入集与首次基线（历史引用，文件已由用户删除）；未宣称业务质量通过。原5419项审核保留，最终来源核验加强后5432项通过，另存后续只读核验（历史引用，文件已由用户删除），未改写首次快照或审核时间。

只读预检与故障定位：`bun run eval:smoke -- --check`和`bun run eval:full -- --check`检查当前文件、配置和计划，不验证真实鉴权、余额、服务可用性或模型质量。共享fixtures使用UTF-8文本，由`.gitattributes`固定LF换行，Windows检出也必须保持一致。入口以`error=dataset_invalid`和固定`reason`区分`review_content_changed`（实际材料或数据与核验记录不一致）及`review_criteria_changed`（判据与核验记录不一致），均返回非零。先检查`git ls-files --eol agent-eval/src/fixtures`；确认只是CRLF/LF差异时恢复文件换行，真实内容变化则重新独立核验。运行时保持原始内容核对，不自动改写文件或审核状态。历史修复与验证见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）。

共享输入换行的历史验证：typecheck 通过，评测工程测试 268 通过、0 失败；Python 普通与 `-O` 各通过 67,494 项检查。Smoke/Full 只读预检及不同工作目录加载均退出 0，分别生成 10/150 个计划 Trial；没有执行真实评测或平台上传。

`ready=true` 表示只读预检通过，执行阶段仍可能失败。启动异常会安全输出 `validation_error` 的字段路径及类型、`filesystem_error` 的固定错误码及操作，或 `location` 中现有评测源文件的位置；不输出配置值、私有文件路径、异常原文或完整堆栈。若预检后失败，请保留这条 JSON，按具体错误继续定位，不能将预检通过当作实际执行通过。

主模型协议与Judge SDK接入的历史证据：2026-10-14用户已执行真实Smoke`smoke-20261013T165746254Z-209638e0`，原始结果为0 PASS、4 FAIL、6 UNJUDGEABLE，Judge实际调用0次。采证显示9次主模型HTTP 404、3次意图识别超时；原报告保留。该批修正主模型协议及Judge SDK接入，仅用本地受控服务验证，当时尚未真实复测；下方各历史批次的NOT_RUN状态只适用于当时。

SDK接入修复的历史工程验证为283通过、0失败，类型检查、Python普通/`-O`、数据引用与Smoke/Full只读预检均通过，该结果仅为当时SDK接入修复的工程证据。原报告独立读回及352个历史归档文件保持不变；当时3次意图超时的根因未关闭。

启动故障诊断的历史验证：typecheck 通过，完整评测工程测试 274 通过、0 失败；覆盖正常执行入口的受控启动失败，以及取消状态下原生 Runner 的 10 题归档与读回。该次用户实际启动异常尚未复现，待原窗口的新错误 JSON 确认根因。

> 终端 E2E 修复结果见 05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）：最终 18 个文件、200 项全部通过，0 失败、0 跳过，退出 0，报告完整。已修复带颜色汇总的解析、报告目录与保存、P11 子进程汇总误判，并补齐 Host 失败诊断。工程原始日志与汇总保存在 `test-results/.runs/<run-id>/`；最新汇总为 `test-results/e2e-results.json`。用户原 199／1、首次修复验证 198／2 和中断记录均保留，Host 原偶发故障根因仍未确认，生产状态机未改。

历史执行规则（工程证据日期2026-10-13）：本地 Smoke 为 10×1，Full 为 50×3；两者直接执行并保存当次快照，上传已有报告使用独立命令。配置不要求人工就绪声明或手填源码清单，源码由控制器自动记录。Judge 校准可独立执行，不是运行前提。本批只进行受控工程验证，真实 Agent/Judge、Smoke/Full 与平台上传仍为 NOT_RUN。数据/本地执行职责见05《MedClaw Agent评测分阶段实施与操作手册》§4–5；终端入口见07《MedClaw Agent本地评测执行操作手册》§3。

Smoke默认10 Case×1 Trial，Full默认50×3，当前Badcase专项默认3×3；三个范围都支持`--trials N`覆盖次数。N=5时分别计划50／250／15个Trial，成员不变。N属于执行参数，不写入Case或模型配置。`--repeat`已移除，使用时提示改用`--trials N`；历史归档中的`repetition`、`aggregation.repeats`及`-rN`身份保持。

Case定义题目、输入、初态、预期与判据；同一Case在一次Execution中按计划生成N个Trial。`repetition`和`trialId`是**Trial记录字段**，通过`caseId`关联Case，并不是Case定义的两个字段。`repetition`从1开始、每题独立计数；`trialId`在本次Execution内唯一，跨执行用`executionId + trialId`定位。进度`index`是冻结计划的全局位置，不能当成同题次数。`case-b-r2`可表示Case B第2次；`[7/250] case-b · Trial 2/5 · case-b-r2`同时表示全局第7项。按计划／数值repetition排序，`r10`不排在`r2`前。多轮消息、工具调用、子Run和子代理均不增加Trial数。

终端分三个时点：每Trial评分后打印该Case对应的全部检查（含PASS、状态、数值／单位、原分子／分母、check、缺口和短证据入口），不再只取3项非PASS；同题N项处理并保存后仅打印一次该Case汇总及重复统计；整轮只打印总五态、正式指标覆盖数量和报告入口。未确认停止／保存时明确标为不完整，不宣称整组已保存。每Case只显示其配置或实际相关的指标，不能固定铺开50行，也不能混入其他Case指标。60秒heartbeat只报阶段／等待，不重复指标表。

正式指标完整名称、内容、方法及条件见01《MedClaw Agent评测总方案》§8.0：新目录v2为50项（31D／19J），Registry140项（121D／19J），原131个ID保留。Case.scorers与appliesTo/独立Gold选择检查；原18项语义与新增answer.partial_failure各自评分，共享完成Trial至多一次独立Judge，无重试或凭据继承。task.success在全部非自身必需检查后派生，Run completed、回答非空和工具成功都不能代替业务完成。

工具recall按必要能力、precision按相关调用/全部真实调用，错误率和Schema合法性各自核验，业务参数仍归tool.params；真实关联失败的重试/授权等价替代/安全停止由tool.recovery检查。所有父子真实尝试计入Case.maxToolCalls。合法空结果可以有有效依据，来源须解析身份/版本/业务日期；freshness按独立业务日期/maxAge核验全部必要来源。efficiency.latency_budget只有显式作者maxMs才选，单调窗口为控制器首次提交send执行请求→全部绑定Run终态、真实停止及必要持久化确认且包含提交RPC开销，排除readywait/prepare/collect/judge，无预算只展示原时延。

`snapshot.qualityMetricCatalog?`冻结该次正式目录、版本及中文名/ID/公式/方向/单位：新执行qualityMetricCatalogVersion为v2的50项（31D／19J），历史v1为原39项（21D／18J）。`report.analysis?`继续使用`medclaw-report-analysis/v1`结构，保存逐Case指标与重复统计、归档目录的整体覆盖、单列完整任务汇总和补充指标。实时与只读report复用`src/reports/analysis.ts`，读回依归档计划/Score/criteria核对；旧报告不补新项、不写回、不重评分。未选中、范围外、不适用/零分母、证据不足、评分错误和执行阻断分别说明，原五态保持；统计、工程条件和正式质量不混成均分或重复计权。

重复统计只对完整有效P/F组计算成功率／pass@k／样本方差，不将设施阻断当随机失败；部分数值显示有效数与缺口。方法依据[Anthropic task／trial、pass@k与回归方法](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)及[OpenAI HumanEval官方估计器](https://github.com/openai/human-eval/blob/master/human_eval/evaluation.py)。命令、受管理环境示例和统计边界见07_MedClaw_Agent本地评测执行操作手册_v1，3. 只读检查。

```powershell
bun run eval:smoke --trials 5
bun run eval:full --trials 5
bun run eval:smoke --trials 5 --check
bun run eval:full --trials 5 --check
bun run eval -- run --dataset medclaw-badcase-v1 --selection full --trials 5 --config agent-eval/configs/agent.json --execution-id NEW_BADCASE_EXECUTION_ID --judge required --backend local
bun run test:e2e
bun run eval:smoke
bun run eval:full
bun run eval:upload -- --execution-id EXECUTION_ID
```

`test:e2e`默认用Bun在终端执行真实Host、SDK、工具、SQLite和产物工作流，使用受控本地模型服务，不启动Electron或浏览器。复用tests/integration的Host用例，以及P4消息和P15问数/纠正/导出工作流；`bun run test:e2e:desktop`单独保留桌面UI覆盖。两种工程入口支持`--stage Pn`和`--check`，终端和桌面结果分开保存。Smoke为10×1，Full为50×3，适用语义检查使用独立Judge；本地保存后显式上传。检查模式不启动产品或模型、不联网、不创建执行/导出文件；退出0表示检查或执行通过，1表示参数/配置/设施/传输错误，2表示准入或质量未通过。

快捷命令按入口文件位置显式读取 `agent-eval/configs/agent.json` 与 `configs/environment`，以 `node:util.parseEnv` 解析中文注释、引号和空行。受管理变量以文件为准，不由同名 Shell 值补齐/覆盖，不修改全局环境。主模型仍只填写 url/key/model，Judge 仅填写 BASE_URL/MODEL/API_KEY 三项；上传仅读取平台配置和指定归档。旧显式 CLI 保留，不增加任意 .env 自动加载；密钥不进入 Agent、快照或日志。

P16桌面Evaluation已经复用这些独立配置，只提供脱敏摘要和Check，不编辑文件或复制聊天Models凭据。开发入口由Main固定装配受管根和独立Bun进程；页面提供Run/Cancel/进度、报告/证据/比较、本地反馈及显式Sync feedback、Upload / Resend。已有聊天和草稿可浏览，新的聊天执行与评测/平台操作互斥；Main以原RuntimeControl核验队列、人工压缩及停止/保存。真实质量、校准和平台通过不是P16工程的历史成绩门槛，真实新Run仍沿当前审核与安全准入。

缺最终report.json时，桌面只读有效snapshot和已核验的原Trial/scoring.completed；Partial不补NOT_RUN或生成最终报告，不允许比较、反馈写入或传输。Case/Trial筛选只改变相应明细，原目录、五态和分母保持；页面重载只查原操作身份，不自动重跑/上传。源码/SDK/补丁变化须确认原执行停止/保存后重启桌面；配置/材料变化重新Check。普通查看缺export.json不建平台ID；显式传输逐项持久化unknown与响应回执，异常恢复复用原ID，必要保存重试零HTTP、零模型/重评分。

Judge 不受确定性高低分触发。独立 MEDCLAW_JUDGE_*，初始温度 0.8、超时 30 秒；每个适用 Trial 最多一次，不自动重试、不切模型、不继承 Agent 密钥。不设置人为输出 Token 上限或整次输出预算，沿用服务端和模型限制。请求数和 Trial 身份仍按计划校验；Agent、意图、压缩、子执行和 Judge 的实际用量分别记录，未知值不填零，不能推算固定费用上界。Case.maxToolCalls、资源预算和采证分页限制继续保留。

Judge 通过 Pi SDK 0.87.1 的独立 Provider 调用，和主模型共用离线原生模型解析；不再手工拼接 `/chat/completions`。URL 与模型原生协议匹配，官方 DeepSeek `/anthropic` 使用 Messages 协议。环境仍只有三项配置，不填写额外 provider 或 Token 限制。SDK 在协议需要时自动发送原生模型上限，应用不设置 `maxTokens`；这是原生能力，不是已删除的 256 Token 或总输出预算。`snapshot.config.judge.nativeModel` 与调用元数据记录目录引用、API、原生输入/输出能力和 SDK 版本，Key 仅传独立 Judge。旧归档不补填这些字段，新旧配置差异仍被比较识别。

DeepSeek 官方仍接受旧名 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp`，实际由 Flash 服务。本项目仅对官方域名按这项已公布映射读取 `deepseek/deepseek-flash` 的原生能力，保留配置和请求中的旧名；不会对任意未知模型或第三方代理猜测映射。[官方模型说明](https://api-docs.deepseek.com/quick_start/pricing/)、[Anthropic 接口说明](https://api-docs.deepseek.com/guides/anthropic_api/)。

Smoke 与 Full 直接从当前制作来源加载，并在执行前保存当次 snapshot.json；Full 首次即可运行，不要求历史 Smoke 成绩或 Judge 校准。Baseline 是用户选择的一次本地执行报告，失败和未运行成员也保留。配置、依赖、数据引用和实际协议继续检查；校准是可选独立工具。

第一阶段已有方案、功能实现、50个短Case、10个Smoke引用及数据审核。历史直接本地执行与完整E2E修复的实际结果见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）。快捷入口修复前的106通过、17失败、30未运行是历史结果；完整E2E修复验证时真实Agent、Judge、Smoke、Full和平台上传均为NOT_RUN。其后真实运行以原报告及当前批次记录为准，工程测试和数据核对通过不代表Agent质量通过。

主集Case参考Folio的`packages/core/src/evaluation.ts`和`packages/shared/src/evaluation/datasets/folio-agent-v1.ts`，普通声明约20–40行，按11类Harness分组。主集集中制作入口是medclaw-agent-v1.ts（src/datasets/medclaw-agent-v1.ts），专项集中入口为上述medclaw-badcase-v1.ts，不生成逐题JSON。公共信息保存业务日期、时区、评分版本、审核策略及Smoke ID。

| 六项标准 | 声明位置 |
| --- | --- |
| 用户输入 | `input.prompt`，必要时补充 `input.turns` |
| 初始环境 | `input.workspaceContext` 的逻辑页面、地区、器械选择，以及 `input.fixture.ref` |
| 成功标准 | `expectedFacts` 或 `goldRef`、回答要点、必要能力和依据要求 |
| 失败标准 | `forbiddenConditions`、禁止能力及公共安全硬约束 |
| 评分方式 | `scorers` 引用 Registry 的方法、维度、单位、阈值和硬约束 |
| 风险点 | `risks`；没有相关风险时显式 `[]` |

现有主集保留英文名称及输入；新常规候选使用中文真实名称或稳定标识，原英文保留挑战用途，业务字面值与共享资料一致。合法空结果采用可表达的类别过滤；缺失日期按query.coverage核对完整目录和登记导入原文，语义评分判断缺失说明，不要求不存在的成功Query。零适用数值分母保留原始0及不适用状态。集中审核绑定公共info、成员、Case、Gold、fixtures及新声明的来源关联，变化后须重新核验。沿用Folio的id/name/category/difficulty/input/expected/tags/source，扩展evalType、多轮输入、结构化事实、Scorer引用和风险标签。复杂事实集中在Gold（src/datasets/medclaw-agent-v1.gold.ts），专项原样复用，不反推模型回答。

保留Folio的id/name/category/difficulty/input/expected/tags/source；Case.evalType仍仅capability/regression。专项用途在caseOrigins中登记，黄金／错题／挑战不改成额外evalType。主集50题sourceRef解析到集中sourceReferences中的产品规范或实际issue；专项另关联实际失败发现身份及最小摘录，业务真值仍为hand-authored合成资料、developer_visible，不能称生产真值或独立留出。

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
D:\code\MedClaw\agent-eval\
├─ README.md
├─ package.json
├─ tsconfig.json
├─ node_modules\                          # 现有依赖，由包管理器管理
├─ configs\
│  ├─ agent.example.json                  # 主模型配置示例
│  ├─ environment.example                # 环境配置示例
│  ├─ agent.json                         # 本地私有配置，不进入评测归档
│  └─ environment                        # 本地私有环境，不进入模型输入
├─ scripts\
│  ├─ export-data.ts                     # 导出制作数据供独立核验
│  ├─ verify-stage-one.py                # 独立CSV／Decimal核验
│  └─ record-data-checks.ts              # 根据实际核验登记数据review
├─ src\
│  ├─ cli.ts                             # 现有run/report/compare等入口
│  ├─ presets.ts                         # Smoke／Full快捷入口及环境读取
│  ├─ desktop\                           # P16独立控制入口、service及安全presentation
│  ├─ evaluation.ts                      # Case、Gold、审核及来源契约
│  ├─ datasets.ts                        # 加载、审核核对、历史快照读取
│  ├─ dataset-compiler.ts                # 编译Case、检查及执行步骤
│  ├─ dataset-fixtures.ts                # 共享材料和初态准备
│  ├─ data-format.ts
│  ├─ independent-gold.ts
│  ├─ datasets\
│  │  ├─ medclaw-agent-v1.ts             # 主集Case及成员
│  │  ├─ medclaw-agent-v1.gold.ts        # 主集独立Gold
│  │  ├─ medclaw-agent-v1.review.json    # 主集数据审核
│  │  ├─ medclaw-badcase-v1.ts           # 当前专项Case及复用关系
│  │  ├─ medclaw-badcase-v1.gold.ts      # 专项独立参考／Gold复用
│  │  └─ medclaw-badcase-v1.review.json  # 专项数据审核
│  ├─ fixtures\                          # 共享业务材料，不按专项重复复制
│  ├─ execution\                         # Trial执行、停止、采证和归档
│  ├─ adapters\                          # 产品入口与原始证据适配
│  ├─ scoring\
│  │  └─ judges\                        # 独立Judge及校准
│  ├─ reports\
│  │  ├─ write.ts                       # 原报告保存、读取和证据校验
│  │  ├─ write-lock.ts                  # 原平台旁记录串行写入；仅可证死所有者恢复
│  │  ├─ compare.ts                     # 已有归档的可比性核对
│  │  ├─ badcases.ts                    # 异常候选派生和Markdown渲染
│  │  └─ analysis.ts                    # Case重复统计与50项覆盖，只读派生
│  ├─ review\                           # 实际反馈，不承担数据审核
│  └─ langfuse\                         # 显式平台映射和传输
├─ tests\                               # 评测工程回归测试
├─ records\
│  └─ <批次>\
│     ├─ issues.md                      # 跨执行问题、归因和维护历史
│     ├─ candidates.json                # 实际制作候选及入集时保存
│     ├─ admission-evidence.json        # 需要冻结最小来源事实时保存
│     ├─ reruns.csv                     # 有实际复测时创建／追加
│     └─ exposure.csv                   # 有实际材料曝光时创建／追加
└─ runs\
   ├─ business\                         # 业务Agent执行的既有输出约定，按实际执行创建
   │  └─ <execution-id>\
   │     ├─ snapshot.json               # 数据、Gold、判据、配置及可选冻结指标目录
   │     ├─ report.json                 # 完整运行才写入；缺失时只读部分原件，不补造
   │     ├─ evidence\<trial-id>\
   │     │  ├─ trial.json
   │     │  ├─ observation.json
   │     │  ├─ events.jsonl
   │     │  └─ artifacts\...            # 实际采证需要时保存
   │     ├─ badcases.json               # 有候选、共因或诊断缺口时
   │     ├─ badcases.md                 # 与JSON同源
   │     ├─ review.json                 # 仅有真实反馈时
   │     └─ export.json                 # 仅有实际导出时
   ├─ research\                         # 既有约定的预留位置，当前未创建
   │  └─ <execution-id>\...             # 将来有受支持研究执行时使用
   └─ calibration\                      # 现有Judge校准入口的输出约定
      └─ <calibration-id>\              # 仅实际执行校准时产生，仅实际执行时按需创建
         ├─ snapshot.json
         ├─ report.json
         ├─ evidence\<sample-id>\
         │  ├─ trial.json
         │  ├─ observation.json
         │  └─ events.jsonl
         ├─ badcases.json               # 有实际诊断内容时
         └─ badcases.md
```

目录树说明现有结构和按需产物约定，不是批量创建清单。当前专项的三个成员属于业务Agent评测，所以结果保存在`runs/business/<execution-id>/`；Badcase还包括设施、数据／Gold、scorer、Judge、reports、review和平台问题，按归因选择原工程测试、数据审核或独立校准，不统一写入business，也不新建Badcase归档分类或专用文件夹。`research`只是预留位置，当前没有研究数据集、执行器或目录；`calibration`仅在实际执行现有独立校准入口时产生，仅实际执行时按需创建。

数据集的`*.review.json`是数据审核；执行目录的`review.json`是真实反馈。`candidates.json`、最小来源包及CSV均按实际需要保存，不创建空文件或占位目录。两份`admission-verification*.json`和`reproductions/`是已删除的历史例外，不是每批必备产物；不新建`verification/`目录，不默认保存独立核验报告。本批`smoke-20261014T034659018Z-665ab02e`历史曾记录256个文件：根目录7个、复现249个；用户现已删除，不恢复或补造。

工程测试继续使用各原入口的实际输出。终端E2E的既有归档位置如下，工程入口按实际验收使用，不启动付费模型：

```text
D:\code\MedClaw\test-results\
└─ .runs\<run-id>\...
```


snapshot保存实际Case、Gold、sourceReferences、fixtures、产品资源正文、审核、配置、编译checks/Gold/Rubric和源代码内容；report合并计划、Trial状态、分数和汇总，引用完整采证。Trial文件合并所有权、隔离、启动、停止及清理证明。产物使用相对路径和实际内容核对，读取归档只读记录JSON，不执行TS，不由当前编译器重算或覆盖旧规则。可选校准保留独立snapshot/report/evidence/<sample-id>结构，当前业务执行使用evidence/<trial-id>，研究结构仅预留；诊断按需派生，不互换报告契约或样本身份。

坏例分析使用`medclaw-badcase-index/v1`，顶层`candidates/commonEvents/gaps`及`summary`的`candidates/signals/trials/samples/cases/commonEvents`分别表达候选、共因、证据缺口与计数；信号按每候选去重后相加。reports模块复用`deriveBadcases(path, baseline?)`、`renderBadcases(index)`、`writeBadcases(path)`：前两者只读派生和渲染，后者用于新业务执行／校准或显式历史补档，三类内容至少一类非空才保存`badcases.json`和`badcases.md`，三者均为空直接返回索引，不写空文件、不删除历史文件，不改Case/Gold、原分数或v1/1版本。既有`bun run eval -- report --execution-id ID`只在内存中重新派生摘要，不写文件：stdout仍是原报告JSON，stderr输出摘要；无诊断内容时说明“无诊断文件需要保存”并省略缺失入口，有诊断内容但未落盘时才标记“尚未保存”。没有新CLI、参数、依赖、模型或自动上传。原始snapshot/report/evidence仍是事实依据。

导航按`badcases.md`候选→原Score/Trial→控制器操作请求/回复→`observation.json`及实际原件逐项核对；`events.jsonl`不能充当完整工具参数/结果或全部模型轨迹。业务Bad、过程Good、Judge ERROR可并存，合法拒绝不证明业务结果已保存；行动机会未成立时，空read/tool清单不能直接确认成Agent行为失败。候选、report.reviewCandidates和真实review.json分开，只有实际反馈才生成后者。节点核验参考[Anthropic Step 6](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)，正负对照及事件检查参考[OpenAI eval-skills](https://developers.openai.com/blog/eval-skills)；项目流程、黄金资格和晋级规则见01_MedClaw_Agent评测总方案_v1，5.8 Good/Bad、黄金、错题和挑战。

当前50题均为hardcoded、hand-authored、synthetic、developer_visible，Smoke之外40题也不构成未曝光holdout。候选按Agent业务Case、设施工程、数据／Gold／判据、scorer正反与不可判对照、Judge合同／合格独立校准、reports／review／平台工程分流；研究仅保留候选，执行能力预留。完整流程见01_MedClaw_Agent评测总方案_v1，5.9.1 候选入集、专项执行与回归维护，结果沿各原入口保存；晋级Case/Gold须显式数据修订、独立核验、重新审核及修订后新基线；自动分析不改变50/10成员。`records/<批次>/reruns.csv`只登记实际新Execution复测，`exposure.csv`只登记实际读取/调参使用，定向坏例不用于估计生产发生率。入口方法参考[LangSmith反馈循环](https://docs.langchain.com/langsmith/evaluation-types)和[OpenAI持续评测](https://developers.openai.com/api/docs/guides/evaluation-best-practices)，记录文件和准入规则由MedClaw规定。

每个 Trial 都保存 `events.jsonl`，未启动时为空；读回拒绝缺少日志、无效记录或 Judge 调用与日志不一致的归档。Judge 只在 `configs/environment` 填写 `MEDCLAW_JUDGE_BASE_URL`、`MEDCLAW_JUDGE_MODEL` 和 `MEDCLAW_JUDGE_API_KEY`，快捷入口显式读取该文件并以文件值为准，不用同名Shell值补齐/覆盖；旧低层CLI仍显式接收调用环境。`agent.json`、示例及其他 `--config` 输入不含 `judge`，出现该字段会被拒绝。运行与记录从这三项环境变量自动生成 `snapshot.config.judge`，保存端点、模型、超时、温度、系统 Rubric 和 SDK 原生能力 nativeModel，不保存 API Key。校准、Smoke、记录、Full 和比较继续核对实际公开配置；读取旧归档使用归档中的配置，不依赖当前环境变量。

被测主模型独立配置在 `configs/agent.json`，`model` 只接受 `url`、`key`、`model` 三项。`url` 填与模型原生 API 协议兼容的服务地址；`model` 精确匹配 Pi SDK 0.87.1 的原生模型目录，支持唯一的模型 ID，有同名项时用 `provider/modelId` 消除歧义（例如 `openai/gpt-4o-mini`，实际请求仍使用 `gpt-4o-mini`）。输入 contextWindow 和输出 maxTokens 均由原生目录解析，不填写 provider、maxTokens 或 contextWindow，不另设评测输出上限；目录缺失或歧义在预检拒绝，不猜测能力。运行时通过产品已有自定义 Provider 入口装载公开端点和原生能力，通过私有凭据通道只提供对应 Provider 的 API Key。快照只保存解析后的公开配置和原生上限；`agent.json` 含密钥，已加入 Git 忽略，不复制到报告或 Trial 工作区。本地原生工具使用当前 Windows 账户权限。Runner 创建独立临时工作区，只向 Host 提供必要环境与公开材料，不把 Gold、Hint、未来输入、审核和 Judge/Langfuse 密钥作为 Agent 输入。独立目录不构成系统权限沙箱；采证核对实际泄漏、所有权、停止和保存，不生成 OS 隔离通过结论。

Dataset/归档基础版本沿用 **v1/1**，正式目录独立采用 **v2**，历史39项目录及原Scorer/Rubric版本冻结，不保存哈希、摘要 ID 或修订号。比较核对实际数据、判据、来源及配置内容。平台 ID 随机生成一次并在 export.json 中复用，反馈和补传不重跑评测。产品和评测公共 DTO 均不含业务哈希；适配器直接绑定实际内容、对象身份和引用，不注入或剥离校验字段。归档不提供密码学防篡改证明。

结果、过程、安全分别评分，基础设施作为准入门槛。可程序判断的事实、单位、集合、日期网格、参数、能力和调用预算使用确定性检查；开放回答及实际采用交给有明确 Rubric 的 Judge。公共reviewPolicy派生report.reviewCandidates：隐私/资金/删除/外发/提示注入等高风险或实际违规、Judge partial/null、真实争议；permission单标签不自动入选。completedReviewRequired:false。第三阶段review enqueue只入选这些候选；入队不等于已审核，review.json只在真实反馈后创建，反馈不覆盖自动分数。公共组合不限制完整调用顺序，也不把可选能力当白名单。

保留 PASS / FAIL / UNJUDGEABLE / ERROR / NOT_RUN 及原始分母，按三维、Harness 和评测用途汇总。`task.success` 只派生业务结果；过程或安全硬失败仍使整体失败，不能被结果分数抵消。缺失证据不算成功，合法空结果可以有充分证据；0、缺失价、缺日期和错误单位分别检查。

材料为显式虚构的采购业务：24 行、浙江和河南共 6 个器械、4 个快照日期，9 月 30 日无快照；金额为整数分，0 与 null 分开。名称、厂家、配送商和价格不声称来自医院、官方或真实经营数据。许可 CC0-1.0，所有题目属于同一 `developer_visible` 合成来源组，没有真实轨迹或未曝光盲测的声明。source-audit仍为公开核验材料；4个Skill题改用query-skill，真实选择resources/skills/query/v1/SKILL.md及references/facts-and-assumptions.md，不再引用不存在的synthetic-source-audit/v1。未使用的 history fixture 与说明文件已移除；每题的 `input.prompt/turns` 通过注册动作建立真实历史，不伪造 SDK 历史文件。

独立 TS 计算（src/independent-gold.ts） 与 Python CSV/Decimal 核验（scripts/verify-stage-one.py） 不读取产品 Query/Diff 结果作为真值。集中 review.json（src/datasets/medclaw-agent-v1.review.json） 保存核对方法、人员/程序身份、时间和实际被核对内容；内容变化后旧审核失效。Agent 只接收当前 prompt、业务日期、允许材料和产品上下文，不接收 Gold、审核、评分规则或未来步骤。

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

`tool.params` 确定性核验原参数的业务对象/日期/范围及依赖；`tool.argument_validity`独立核验调用当期Schema，原参数和Hook后最终参数分别留证。二者与 `answer.faithful` 等语义检查分开。Judge只消费选中且适用的语义要求；参数或持久事实缺证据不能由Judge补判正确。

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

该历史批次 `doctor`实际退出1、ready=false：OS Gold 隔离、P15 真实语义就绪门槛尚未关闭，仓库声明的 subagent patch 文件缺失。当时未启动质量运行；当前执行规则见05《MedClaw Agent评测分阶段实施与操作手册》§2–5。测试使用回环受控服务，验证真实本地 Host 的确定性查询、导出、分页、恢复与停止，不调用 Agent 或 Judge 模型。30 秒停止超时测试按设计保留故障证明。

第二阶段才执行独立 Judge 校准、10×1 Smoke、当次记录和 50×3 Full；平台接入验收属于第三阶段。配置示例不含凭据，明确从控制端环境读取 Judge/平台密钥，不隐式加载任意 .env（快捷入口显式读取固定 environment），不继承到产品子进程。旧 150 文件数据已在替换前保存在忽略目录 `.superpowers/sdd/medclaw-eval-v1/backup-20261013-015345/`。

Judge配置去重后的本批受控验证见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）：类型检查通过，完整工程套件242 pass/0 fail（38文件、1,417项expect、75.10秒）。仅环境中的三项变量作为Judge输入，运行/记录自动归档不含密钥的实际配置；用户已填写值保留，真实质量状态仍NOT_RUN。

独立主模型配置的本批验证见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）：类型检查通过，完整工程套件249 pass/0 fail（39文件、1,457项expect、71.97秒）。三字段输入、原生能力、私有凭据、独立归档及端点比较均有受控检查，无真实推理、平台上传。

采用 Folio 的短声明、共享文件和独立加载：fixture 加载器（D:/code/agent-learn/agent/folio/packages/longbridge-tools/src/testing/load-fixture.ts:14）、来源及接口说明（D:/code/agent-learn/agent/folio/packages/longbridge-tools/src/testing/fixtures/README.md:3）。Folio 的真实 CLI 输出有采集命令记录；MedClaw 当前资料为显式合成来源，集中记录制作方法、许可和范围，不伪造真实采集。

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

参考：[LangSmith Evaluation types](https://docs.langchain.com/langsmith/evaluation-types)、[Anthropic Agent evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)、[OpenAI Graders](https://developers.openai.com/api/docs/guides/graders)。章节、操作和后续阶段见 docs/evals（../docs/evals）。

数据与评测工程交付历史验证（证据日期2026-10-13）：根目录与agent-eval类型检查通过，评测工程测试193/193通过；Python普通和`-O`各19,876项核验通过，覆盖50题、62组阶段真值和24行源数据，核验脚本可从不同工作目录执行。Case含63次真实注册用户输入，声明24–31行。总方案恢复完整章节和附录、15篇外部资料及正文落点；当时本地链接和章节锚点检查通过（仅历史工程事实）。数据制作和后续阶段职责见05《MedClaw Agent评测分阶段实施与操作手册》§4–6。

功能专属预期与受控故障的历史验证以05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）记录新增受控核验，各次验证单独保留实际计数。每题预算与证据依据、sourceRef、失败检查映射及强类型Gold预期重新内容审核。新select_resources动作在new_session之后、send之前，复用桌面MainSettings prepare/commit/abort；控制器索引读取不算Skill使用。可信HostHello的controlledToolFault只对query-timeout-once开放，每Host首个获准查询在业务效果前实际tool_timeout一次；重试题cap8/maxRetries1并检查tool.failure_handling。全部真实质量与平台运行仍NOT_RUN。

功能专属预期的历史核验：typecheck退出0；`bun --no-env-file test ./agent-eval/tests`为238 pass/0 fail（38文件、1,397项expect、65.44秒，delivery-engineering-tests-final.log）；包含真实本地Host资源/私有inventory/受控错误和local平台mock，真实模型调用0。Python普通和-O在verified记录上各67,644项检查退出0；最终审核时间2026-10-13T04:39:36.735893Z。50题25–33行、62阶段真值、24行源数据、100项不同失败、50sourceRef/11真实章节已核验；dataset validate在根目录与agent-eval cwd均退出0、readiness=reviewed，来源审计50 developerVisible/0 blind。最终独立审查无Critical/Important遗留问题；审核后的closeout/verification受控检查为6 PASS、29项assert。该批预检退出1保留OS隔离、P15和缺subagent补丁门禁，SDK0.87.1/patchPresent=false；后续本地执行/E2E修复验证已处理这些前提及补丁缺失，历史真实质量与平台保持NOT_RUN。


历史快捷入口与Judge输出限制清理见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）：当时类型检查通过，评测工程套件260 pass/0 fail；完整桌面E2E为106通过、17失败、30 skipped/未运行，退出1，尚未全部通过。该批只读Smoke/Full预检返回准入退出2，受控归档上传预检退出0且未联网。用户配置值保持，真实质量和上传仍NOT_RUN；当时失败清单和实际命令属于该历史验证，不借用其他批次通过数。

直接本地执行与完整E2E修复的历史验证：类型检查退出0；完整unit/integration为1604通过/0失败（120文件），评测工程套件260通过/0失败（40文件、1,539项expect），当时`bun run test:e2e`执行桌面UI测试，为153执行/153通过/0失败/0跳过（24文件）；该覆盖现由`test:e2e:desktop`保留。截图用例两轮8项、P1/P7完整文件两轮56项均通过。Python普通与`-O`各67,494项核验通过并更新集中审核；50Case/62阶段真值/10Smoke/11Harness保持。精确Subagent补丁恢复后，干净`bun install --frozen-lockfile`安装143包并验证Pi0.87.1与managed接口。Smoke10×1、Full50×3及受控归档上传预检均退出0，不需要历史成绩或校准记录；上传检查不联网、不改变归档。实际配置仍被Git忽略，runs为空。完整命令、日志与历史失效证据说明见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）。真实模型评测、真实Judge校准和平台上传仍为NOT_RUN。

终端执行入口的历史验证见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）：`bun run test:e2e`实际执行18文件、200项全部通过，0失败、0跳过，475.88秒；进程采样未发现Electron。原24个桌面文件由`test:e2e:desktop`单独保留。类型检查退出0；完整单元及快捷入口检查为36文件、375通过/0失败。终端汇总/JUnit和桌面结果分开保存。本次使用本地受控服务，用户配置和数据集保持，真实质量及平台仍NOT_RUN。

Smoke/Full 正常执行采用中文逐题阶段输出：准备公开输入→Host→Agent→停止与采证→评分→保存，每 60 秒显示等待心跳。✅ 表示对应阶段完成，最终五态及主要失败检查另行展示；--check 和底层 CLI 保留 JSON。只有评分事件落盘后才显示结果已保存。公开材料通过当前附件清单送达，压缩历史由固定真实 SDK 用户轮次建立；准备工具调用计入 Trial 总预算。Judge 使用判据所需去重证据，不增加 Token 上限。

SDK采证与逐题评分工程验证（证据日期2026-10-14）：类型检查通过，评测工程套件**304通过／0失败（46文件）**；Python普通及`-O`各**67,544**项通过；dataset validate/audit-lineage和Smoke/Full `--check`均退出0。受控本地服务验证了真实SDK的短历史no_op、默认长历史压缩，以及逐题读取材料、一次Judge、评分和保存流程。该批已有真实Smoke的**0 PASS／7 FAIL／3 UNJUDGEABLE**保持，当时修订未执行真实质量运行或上传。该工程验证不提供真实质量或上传成绩；终端样例见07_MedClaw_Agent本地评测执行操作手册_v1，4. 本地 Smoke 10×1。

原始保存结构继续为snapshot.json、report.json、evidence/<trial-id>/{trial.json,observation.json,events.jsonl,artifacts/}，当前报告模块另派生badcases.json/.md；只有实际产物、反馈或平台导出才创建对应可选文件。临时导出位于所属临时工作区；旧运行不改写、不自动重评分。所述SDK采证与评分修复只有受控本地验证证据。


运行归档按用途保存到 `runs/business/<execution-id>/`（业务）、`runs/research/<execution-id>/`（研究）和 `runs/calibration/<execution-id>/`（独立 Judge 校准）。当前50题为业务集，研究目录预留；工程测试仍在独立 `test-results/`。复核及导出保留在所属执行内。 当前 Smoke/Full 自动写 business，校准省略 --output 自动写 calibration；业务/研究报告按 ID 统一查找，跨类同 ID 拒绝选择。完整目录、分类依据及数据交付状态见 05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）；06仅保留前七个制作步骤。

Trials与指标受控工程验证（证据日期2026-10-15）：399 PASS／0 FAIL、类型检查退出0；主集普通／-O核验各71531项通过。专项缺用户已删除的历史来源，review保持pending、结构状态draft；没有真实复测、校准或上传。完整结果与边界见05《MedClaw Agent评测分阶段实施与操作手册》的历史工程记录（原附录已移除，事实仅按本README保留的记载理解）。

P16当前受控工程验证：单元44/44、集成58/58、终端Host 8/8、真实Electron 28/28，四类均零失败/跳过、退出0、报告完整；独立评测434/434（56文件）。原失败与专项复测记录保留，完整证据见medclaw-p16-evaluation第5.3节。测试使用实际SDK/Host/SQLite及回环协议，包含平台三个真实进程退出窗口、原ID恢复、保存/释放锁同时失败后的零HTTP保存恢复；没有执行真实外部模型、校准、Langfuse上传或安装验收。正式50/Registry140、主集50/Smoke10、历史v1的39项、专项pending及延迟SLO缺口保持。
