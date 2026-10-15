import {expect,test} from 'bun:test';
import {QueryRecordSchema,QueryParamsSchema} from '../../packages/contracts/src/query';
import {queryRowKeys,resolveQueryRow} from '../../packages/storage/src/workspace-selection';

test('saved aggregate row identities remain distinct across pages and cannot select another query',()=>{
  const query=QueryRecordSchema.parse({id:42,sessionId:1,runId:1,callRef:'aggregate',kind:'aggregate',
    params:QueryParamsSchema.parse({kind:'aggregate',population:'snapshot',snapshotMode:'exact_date',batchIds:[1],metric:'count'}),
    batchIds:[1],scopeDeviceIds:null,rows:[{value:7,region:'浙江'},{value:7,region:'浙江'}],snapshotIds:[],eventIds:[],warnings:[],
    calculationVersion:'medclaw.query/v1',createdAt:'2026-10-15T00:00:00.000Z'});
  const keys=queryRowKeys(query);
  expect(keys).toEqual(['row:42:0','row:42:1']);
  expect(keys.slice(1,2)).toEqual(['row:42:1']);
  expect(resolveQueryRow(query,keys[1]!)).toEqual(query.rows[1]!);
  expect(()=>resolveQueryRow({...query,id:43},keys[1]!)).toThrow('access_denied');
  expect(queryRowKeys({...query,kind:'current',rows:[{snapshotId:9},{snapshotId:9}]})).toEqual([null,null]);
});
