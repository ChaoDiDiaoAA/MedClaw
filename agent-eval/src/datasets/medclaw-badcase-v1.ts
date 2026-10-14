import type {CaseDefinition,CaseOrigins,DatasetLineage} from '../evaluation.ts';
import {cases as originalCases} from './medclaw-agent-v1.ts';
const original=(id:string)=>{const item=originalCases.find(item=>item.id===id);if(!item)throw new Error('badcase_parent_missing:'+id);return item;};
const english=original('mc-v1-intent-resolve');
export const datasetInfo={
  "id": "medclaw-badcase-v1",
  "version": 1,
  "name": "MedClaw Badcase 专项评测集",
  "description": "Three reviewed intent conditions from one developer-visible synthetic source; independent of the primary 50/10 selection.",
  "createdAt": "2026-10-14T10:09:54.738Z",
  "referenceDate": "2026-10-02",
  "timezone": "Asia/Shanghai",
  "scoringVersion": "v1",
  "reviewPolicy": {
    "triggers": [
      "high-risk",
      "disputed",
      "judge-uncertain"
    ],
    "completedReviewRequired": false
  }
} as const;
export const cases:CaseDefinition[]=[
  {...english,id:'mc-bc-intent-zh-name',name:'中文名称唯一实体的意图查询',evalType:'capability',input:{...english.input,prompt:'查询浙江“合成输注泵 A”在 2026-10-02 的采购价格，并给出数据日期和来源。'},expected:{...english.expected,goldRef:'mc-bc-intent-zh-name'},sourceRef:'badcase-intent-expression'},
  english,original('mc-v1-intent-clarify-region'),
];
export const smokeIds:string[]=[];
export const caseOrigins:CaseOrigins={
  "mc-bc-intent-zh-name": {
    "batchId": "smoke-20261014T034659018Z-665ab02e",
    "evidencePacketRef": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/admission-evidence.json",
    "issueId": "MC-BC-004",
    "sourceExecutionId": "intent-controls-20261014T084749788Z-9923143d",
    "sourceCaseId": "mc-v1-intent-resolve",
    "sourceTrialId": "mc-v1-intent-resolve-zh-name-r1",
    "derivedFromCaseId": "mc-v1-intent-resolve",
    "purpose": "capability",
    "changes": [
      "id",
      "name",
      "evalType",
      "input.prompt",
      "expected.goldRef",
      "sourceRef"
    ],
    "evidenceRefs": [
      {
        "path": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/reproductions/intent-controls-20261014T084749788Z-9923143d/evidence/mc-v1-intent-resolve-zh-name-r1/observation.json",
        "pointer": "/executionId",
        "value": "intent-controls-20261014T084749788Z-9923143d"
      },
      {
        "path": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/reproductions/intent-controls-20261014T084749788Z-9923143d/evidence/mc-v1-intent-resolve-zh-name-r1/observation.json",
        "pointer": "/trialId",
        "value": "mc-v1-intent-resolve-zh-name-r1"
      },
      {
        "path": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/reproductions/intent-controls-20261014T084749788Z-9923143d/evidence/mc-v1-intent-resolve-zh-name-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/state",
        "value": "completed"
      },
      {
        "path": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/reproductions/intent-controls-20261014T084749788Z-9923143d/evidence/mc-v1-intent-resolve-zh-name-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/prediction/status",
        "value": "RESOLVED"
      }
    ]
  },
  "mc-v1-intent-resolve": {
    "batchId": "smoke-20261014T034659018Z-665ab02e",
    "evidencePacketRef": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/admission-evidence.json",
    "issueId": "MC-BC-004",
    "sourceExecutionId": "smoke-20261014T073809305Z-9dc36ff0",
    "sourceCaseId": "mc-v1-intent-resolve",
    "sourceTrialId": "mc-v1-intent-resolve-r1",
    "derivedFromCaseId": "mc-v1-intent-resolve",
    "purpose": "challenge",
    "changes": [],
    "evidenceRefs": [
      {
        "path": "agent-eval/runs/business/smoke-20261014T073809305Z-9dc36ff0/evidence/mc-v1-intent-resolve-r1/observation.json",
        "pointer": "/executionId",
        "value": "smoke-20261014T073809305Z-9dc36ff0"
      },
      {
        "path": "agent-eval/runs/business/smoke-20261014T073809305Z-9dc36ff0/evidence/mc-v1-intent-resolve-r1/observation.json",
        "pointer": "/trialId",
        "value": "mc-v1-intent-resolve-r1"
      },
      {
        "path": "agent-eval/runs/business/smoke-20261014T073809305Z-9dc36ff0/evidence/mc-v1-intent-resolve-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/state",
        "value": "completed"
      },
      {
        "path": "agent-eval/runs/business/smoke-20261014T073809305Z-9dc36ff0/evidence/mc-v1-intent-resolve-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/prediction/status",
        "value": "NEED_PARAMETERS"
      }
    ]
  },
  "mc-v1-intent-clarify-region": {
    "batchId": "smoke-20261014T034659018Z-665ab02e",
    "evidencePacketRef": "agent-eval/records/smoke-20261014T034659018Z-665ab02e/admission-evidence.json",
    "issueId": "MC-BC-004",
    "sourceExecutionId": "full-20261014T074335161Z-1e7c7f66",
    "sourceCaseId": "mc-v1-intent-clarify-region",
    "sourceTrialId": "mc-v1-intent-clarify-region-r1",
    "derivedFromCaseId": "mc-v1-intent-clarify-region",
    "purpose": "control",
    "changes": [],
    "evidenceRefs": [
      {
        "path": "agent-eval/runs/business/full-20261014T074335161Z-1e7c7f66/evidence/mc-v1-intent-clarify-region-r1/observation.json",
        "pointer": "/executionId",
        "value": "full-20261014T074335161Z-1e7c7f66"
      },
      {
        "path": "agent-eval/runs/business/full-20261014T074335161Z-1e7c7f66/evidence/mc-v1-intent-clarify-region-r1/observation.json",
        "pointer": "/trialId",
        "value": "mc-v1-intent-clarify-region-r1"
      },
      {
        "path": "agent-eval/runs/business/full-20261014T074335161Z-1e7c7f66/evidence/mc-v1-intent-clarify-region-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/state",
        "value": "completed"
      },
      {
        "path": "agent-eval/runs/business/full-20261014T074335161Z-1e7c7f66/evidence/mc-v1-intent-clarify-region-r1/observation.json",
        "pointer": "/facts/intents/0/calls/0/prediction/status",
        "value": "NEED_PARAMETERS"
      }
    ]
  }
};
export const lineage:DatasetLineage={contract:'medclaw-eval-lineage/v1',version:1,groups:[{id:'synthetic-procurement-v1',sourceRefs:['fixtures/procurement.csv'],caseIds:cases.map(item=>item.id),partition:'developer_visible',exposure:'developer_visible',origin:'synthetic_authored',parentGroupIds:[],notes:'Shared synthetic procurement source. Language and clarification variants are not independent source groups.'}]};
