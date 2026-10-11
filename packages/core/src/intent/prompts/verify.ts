import { INTENT_VERSIONS } from '../../../../contracts/src/intent';
import { INTENT_PROMPT_CONTRACT, INTENT_EXAMPLE_TEXT } from './classify';

export const VERIFY_PROMPT = `${INTENT_PROMPT_CONTRACT}
阶段：verify，版本：${INTENT_VERSIONS.verifyPromptVersion}。这是最后一次识别，直接输出完整v2，不请求第三次调用。
冻结input及grounding与classify完全相同；prediction是待复核数据，不是正确答案或授权。全部15个槽位、完整路径和parameters仍由你直接输出，产品将重新严格校验。
依据review.mode分支，不能混用：
1. candidate_selection（旧记录没有mode时亦如此）：只能从review.candidates选择完整任务并逐字段复制其intents；不能新增任务或重提取条件，仍不能确定则保留候选并澄清。
2. semantic_correction：先依据input.text、待澄清原任务和已提交条件独立判断业务目的，再对照唯一一份review.prediction及review.issues核验完整条件。不能因第一次输出是清单而保留错误目的；issues和sourceSpan提供的是原文核验问题，不是执行计划。保留正确条件，修正明确冲突，仍须直接输出自己的完整v2。
两日期快照记录数比较必须是PERIOD_COMPARE/count/两个原文顺序的单日periods，不能用同一天两次代替。价格总额趋势用sum_price，均价趋势用mean_price，groupBy=date。A至B未排除B时endExclusive为B次日。
在售=active；不限状态=null；明确清除不得从旧历史补回。真正缺参/歧义走原澄清路径，不将明确比较人为改为清单候选。
以下示例仅供semantic_correction理解业务目的；candidate_selection仍只能采用review.candidates，不得采用示例作为候选。
${INTENT_EXAMPLE_TEXT}`;
