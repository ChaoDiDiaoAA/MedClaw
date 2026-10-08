# MedClaw 本地 WSL2 + ms-swift 微调实施计划

日期：2026-10-08，Asia/Shanghai。版本：sft-execution/v2。保留原路径、完整替换远端路线。本文件仅为计划，脚本与配置是拟新增项，命令仅作为后续实施示例；本文不表示实现代码已存在或训练已完成。本次交付范围为计划文档。

目标：12,000条数据 → 本机RTX5060 LoRA SFT → 验证选模 → 原生合并、GGUF量化 → Windows Ollama medclaw-intent:v1。标签依据 [产品第19章](../../spec/00_MedClaw完整产品方案_v1.md)，设计见 [sft-design/v2](../../PT/04_MedClaw_Qwen3.5-0.8B_LoRA_SFT微调总方案_v1.md)。

## 固定环境与入口

WSL Ubuntu-24.04，yyc；现有conda /home/yyc/miniforge3/envs/medclaw。官方源码 /home/yyc/projects/ms-swift 固定8cb6868330df93b1939b3091d2e993f205480b04；基座 /home/yyc/models/qwen/Qwen3.5-0.8B，revision未知、现有文件SHA冻结；项目 /home/yyc/workspaces/medclaw；Windows发布 D:\medclaw-finetune\release。

Windows负责文档/Ollama，WSL负责数据、训练、合并和转换。无AutoDL/SSH、产品接入、Agent Benchmark、UI、查询服务或Langfuse。不设GPU时长上限。训练时释放Ollama GPU占用。

~~~bash
source /home/yyc/miniforge3/etc/profile.d/conda.sh
conda activate medclaw
cd /home/yyc/workspaces/medclaw
export HF_HOME=/home/yyc/cache/huggingface
export HF_HUB_CACHE=/home/yyc/cache/huggingface/hub
export MODELSCOPE_CACHE=/home/yyc/cache/modelscope
python -m pip check
~~~

## 步骤1：本地准备和文档

修订总方案第1、4—15章，重点第6章Windows/WSL分工、第7章本地命令。复用既有环境和模型，核查GPU/BF16、架构/权重、源码commit、依赖和文件hash。fsspec[http]=2026.2.0，补jsonschema；decord官方wheel内部错误Tag仅修元数据，保留原包/修复包hash。更新README真实版本。

完成标准：pip check、导入和CUDA/BF16通过；reports/environment.json、requirements.lock.txt、base-manifest.json可核查。官方ms-swift仓库不放项目数据或产物。

## 步骤2：12,000条规则审核记录

训练10,000、验证1,000、独立测试1,000，十类每类1000/100/100。先隔离实体池、模板族、对话/改写来源，seed42。每分区组合≥30%、多轮≥25%；覆盖日期/阈值/否定清除/域外歧义、对象数与事件数。只用规则化语义任务，不调用外部生成API、不读取正式Gold或把业务表格冒充对话。

~~~bash
python scripts/prepare_dataset.py --generate
~~~

计划将原始datasets/raw/medclaw_original.jsonl设为只读，标签修改需新版本。记录source lock、审核方法与分组；逐条规则审核。明确记录humanReviewed状态，不将自动检查冒称人工复核或真实用户泛化。

## 步骤3：messages投影、校验与冻结

~~~bash
python scripts/split_dataset.py
python scripts/make_smoke_dataset.py
python scripts/validate_dataset.py --tokens
python -m unittest discover -s scripts -p test_pipeline.py
~~~

输出train10000、validation1000、test1000、smoke50。历史assistant loss:false，最后JSON loss:true；损失last_round+ignore_empty_think。实际逐条编码保证输入≤1536、答案≤512、总长≤2048，官方模板一致、Prompt/历史/空think/padding无监督。检查source组无交叉、重复、语义、文件hash和实际加载数。错误不得静默裁剪丢弃。

计划产物：configs/intent.prompt.txt、intent.schema.json、data-manifest.json、data-validation.json、smoke-manifest.json。

## 步骤4：50条真实冒烟，最多20步

~~~bash
bash scripts/train_lora.sh smoke
~~~

BF16/SDPA，rank16 alpha32 dropout.05；原生all-linear只匹配语言decoder，视觉/aligner/embedding/lm_head/MTP冻结。最大2048、batch1、累积16、lr1e-4；checkpointing非reentrant，logits_to_keep，单进程/worker0，无packing。独立smoke目录，真实forward/backward、有限loss和梯度/权重更新、保存重载、完整恢复材料、峰值资源。

完成标准：链路通过且资源有余量；正式训练单独启动。OOM先查实际占用/配置，不减少数据、不自动切QLoRA。

## 步骤5：三个epoch正式训练、验证选模

~~~bash
bash scripts/train_lora.sh train
bash scripts/eval.sh base validation
bash scripts/eval.sh adapter validation /绝对路径/真实checkpoint
~~~

原生swift sft YAML位置参数，正式10000/1000；每epoch验证和完整checkpoint，保留3份，save_only_model=false，load_best=false。输出exp001，日志logs。experiment-identity.json冻结配置、数据、基座、Prompt/Schema、审计代码、源码commit与核心包版本，每个checkpoint记录完整恢复文件hash。恢复前检查旧进程，通过下列入口核验同一实验及optimizer/scheduler/RNG/Trainer等全部状态；只加载adapter算新实验。

~~~bash
bash scripts/train_lora.sh train /home/yyc/workspaces/medclaw/outputs/qwen35-08b-lora/exp001/checkpoint-实际步数
~~~

释放GPU后用swift infer的Transformers后端串行比较base和三个epoch。最后Gold从输入移除；batch1、temperature0、非思考、512生成上限。已有预测文件拒绝追加。坏JSON/缺失/超时计错，报告真实support及关键槽位共享null不虚增。

只剥离原生解码附回的固定空思考输入预填前缀，保留原始响应；非空思考、重复前缀及坏JSON仍计错。

排序：全JSON语义精确匹配→Macro-F1→关键槽位→较低val loss→较早epoch。selection.json保存实际选中路径和理由，不直接选最后checkpoint。

## 步骤6：CPU原生合并并核对

~~~bash
bash scripts/merge_lora.sh
bash scripts/eval.sh merged validation
~~~

swift export YAML指定同基座、选中adapter、merge_lora=true、BF16、CPU、独立分片输出。保留processor/tokenizer/config/template。merged独立加载，同验证输入比较adapter/merged语义差异；新增边界错误先排查。原adapter和checkpoint保留。

## 步骤7：GGUF转换、量化、发布包

llama.cpp独立checkout /home/yyc/projects/llama.cpp 固定18b5f8b1862ebfe0f1c33d2355b81a54d2fec867，CPU CMake构建并行2。缺少的构建依赖单独补齐，转换若冲突用独立环境。官方文本converter merged HF→F16 GGUF→Q4_K_M；惰性读取，必要时--use-temp-file。不得改架构或跳过未知张量。

发布GGUF、Modelfile、冻结Prompt/Schema、验证/测试、评价工具、配置、清单和报告，复制/mnt/d/medclaw-finetune/release后重新核查hash。WSL原件和完整checkpoint保留并备份；副本验证。

## 步骤8：Windows Ollama验证和正式发布

Windows检查/api/version，创建F16/Q4候选，Windows Python调用127.0.0.1:11434。每次完整Schema format、think=false、stream=false、temperature0、num_ctx2048、num_predict512、冻结Prompt。检查实际模板/结束符/非思考行为。

同1000验证数据比较F16/Q4：全JSON下降≤1个百分点，日期/阈值/清除/域外无新增错误；否则Q8_0验证。仍失败就保留报告，暂停正式tag。

checkpoint和量化规格冻结后，封存test1000只用于接受/拒绝，不用于选模。HF base/adapter单独比较收益，Ollama另报部署结果。质量目标：Schema≥98%，Macro-F1≥.90，全槽位≥90%，全JSON≥85%，关键槽位≥95%，澄清/域外召回各≥95%，域内误拒≤2%，HF收益≥2个百分点且关键指标无明显退化。

全部通过才创建medclaw-intent:v1；旧tag先备份，记录真实digest、GGUF/模板/Prompt/Schema hash、训练配置/数据版本和真实测试报告。未通过候选不冒称通过，暴露测试后调参需回验证集并记录已暴露。

## 交付和状态记录

后续实施时，待smoke保存、重载和恢复通过后，可编写scripts/run_pipeline.sh串行执行步骤5—8。以下仅为未来启动长任务的示例：

~~~bash
tmux new-session -d -s medclaw-exp001 'cd /home/yyc/workspaces/medclaw && bash scripts/run_pipeline.sh > logs/pipeline-exp001.log 2>&1'
~~~

后续实施应记录实际阶段、退出状态和全过程日志，使用进程锁避免重复启动；任一质量门失败即停止。恢复时依据日志和真实checkpoint路径执行对应单步命令，不覆盖已生成文件。

后续完整实施的目标产物为四份数据及来源清单、环境/模型身份、配置脚本、真实smoke/训练/选模/合并/量化/测试报告、adapter、完整checkpoint、merged HF、GGUF及Ollama身份。实施过程中记录实际进度；失败保留可恢复材料和明确失败点。合成分布成绩不替代真实用户或完整Agent评测。
