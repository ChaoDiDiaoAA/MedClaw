import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { openDatabase } from '../../packages/storage/src/database';
import { Repositories } from '../../packages/storage/src/repositories';
import { seedWorkspaceQueries } from '../fixtures/p7-workspace';

// Break caught: failed creation leaves a Session or clears the previous adopted
// Query/row/field before the transaction can commit.
test('A15 failed Session creation preserves every selected Query workspace byte and the original saved facts', () => {
  const root=mkdtempSync(join(tmpdir(),'p7-create-rollback-')),db=openDatabase(join(root,'app.sqlite'));
  try {
    const f=seedWorkspaceQueries(db);
    const selected=f.repos.updateWorkspace({queryId:f.current.id,activeView:'query',selection:{formatVersion:1,kind:'query-row',targetId:String(f.current.id),targetVersion:f.current.resultHash,rowKey:'snapshot:1',field:'priceCents'}},2,'2026-10-04T00:00:01.000Z');
    const tables=['workspace','sessions','queries','query_evidence','runs','session_inputs','model_calls'],facts=()=>Object.fromEntries(tables.map(table=>[table,db.query(`SELECT * FROM ${table} ORDER BY id`).all()]));
    const before=facts(),failing=new Repositories(db,()=>{throw new Error('creation commit fault');});
    expect(()=>failing.createSession({expectedWorkspaceRevision:selected.revision},'create-b','native-b','2026-10-04T00:00:02.000Z')).toThrow('creation commit fault');
    expect(facts()).toEqual(before);expect(f.repos.listSessions({}).sessions).toHaveLength(1);expect(f.repos.readWorkspace()).toEqual(selected);
    const reread=f.queries.read(f.current.id,{...f.context,callRef:'read-original'});
    expect(reread.resultHash).toBe(f.current.resultHash);expect(reread.rows).toEqual(f.current.rows);expect(facts()).toEqual(before);
  } finally {
    db.close();const within=relative(resolve(tmpdir()),resolve(root));if(within&&!within.startsWith('..')&&!within.includes(':'))rmSync(root,{recursive:true,force:true});
  }
});
