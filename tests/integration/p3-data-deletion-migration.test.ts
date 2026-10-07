import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openDatabase} from '../../packages/storage/src/database';
import {seedWorkspaceQueries} from '../fixtures/p7-workspace';
import {HOST_PROTOCOL_VERSION,DATABASE_SCHEMA_VERSION,publicMethodSchemas,isReadOnlyMethod} from '../../packages/contracts/src/protocol';

const files=['001_p1.sql','002_p2.sql','003_p3.sql','004_p5.sql','005_p6.sql','006_session_lifecycle.sql'];
function legacy(){const root=mkdtempSync(join(tmpdir(),'batch-migration-')),path=join(root,'app.sqlite'),db=new Database(path);db.exec('PRAGMA foreign_keys=OFF');for(const [i,file]of files.entries()){db.exec('PRAGMA foreign_keys=OFF');const sql=readFileSync(new URL(`../../packages/storage/src/migrations/${file}`,import.meta.url));db.exec(sql.toString());db.query('INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)').run(i+1,createHash('sha256').update(sql).digest('hex'),'2026-10-04T00:00:00.000Z');}db.exec('PRAGMA foreign_keys=ON');seedWorkspaceQueries(db);return {root,path,db};}

test('batch deletion migration preserves legacy rows/markers and adds lifecycle/ledger without rewriting history',()=>{
 const f=legacy();let db=f.db;try{const markers=db.query('SELECT * FROM schema_migrations').all(),queries=db.query('SELECT * FROM queries').all(),snapshots=db.query('SELECT * FROM snapshots').all();db.close();db=openDatabase(f.path);
 expect(db.query('SELECT COUNT(*) n FROM schema_migrations').get()).toEqual({n:12});
 expect(db.query('SELECT * FROM schema_migrations WHERE version<=6').all()).toEqual(markers);
 expect(db.query('SELECT * FROM queries').all()).toEqual(queries);expect(db.query('SELECT * FROM snapshots').all()).toEqual(snapshots);
 expect(db.query('SELECT status,deleted_at,deletion_operation_ref FROM batches').get()).toEqual({status:'active',deleted_at:null,deletion_operation_ref:null});
 expect(db.query('SELECT COUNT(*) n FROM data_deletions').get()).toEqual({n:0});expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);expect(db.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});
 }finally{db.close();rmSync(f.root,{recursive:true,force:true});}
});
test('batch deletion migration never reuses deleted snapshot/change/device integer identities',()=>{
 const f=legacy();let db=f.db;try{db.close();db=openDatabase(f.path);db.query('DELETE FROM snapshots WHERE id=3').run();db.query('DELETE FROM devices WHERE id=3').run();
 const device=db.query("INSERT INTO devices(source_device_id,source_bundle_id,source_submission_id,source_refs_json,created_at) VALUES('replacement','bundle','submission','[]','2026-10-04T00:00:00.000Z')").run();expect(Number(device.lastInsertRowid)).toBeGreaterThan(3);
 const snapshot=db.query("INSERT INTO snapshots(batch_id,device_id,device_name,region,currency,unit,source_row_ref,source_refs_json,field_origins_json) VALUES(1,?,'new','浙江','CNY','台','new-row','[]','{}')").run(device.lastInsertRowid);expect(Number(snapshot.lastInsertRowid)).toBeGreaterThan(3);
 for(const name of ['devices','snapshots','change_events'])expect(String(db.query<{sql:string},[string]>('SELECT sql FROM sqlite_schema WHERE name=?').get(name)?.sql)).toContain('AUTOINCREMENT');
 }finally{db.close();rmSync(f.root,{recursive:true,force:true});}
});
test('batch deletion migration failure rolls back all tables and marker before reopening successfully',()=>{
 const f=legacy();try{const old=f.db.query('SELECT * FROM batches').all();f.db.close();let attempted:Database|undefined;try{expect(()=>{attempted=openDatabase(f.path,phase=>{if(phase==='batch_deletion_marker')throw new Error('fixture');});}).toThrow('storage_migration_failed');}finally{attempted?.close();}const raw=new Database(f.path);try{expect(raw.query('SELECT COUNT(*) n FROM schema_migrations').get()).toEqual({n:6});expect(raw.query('SELECT * FROM batches').all()).toEqual(old);}finally{raw.close();}const recovered=openDatabase(f.path);try{expect(recovered.query('SELECT COUNT(*) n FROM schema_migrations').get()).toEqual({n:12});}finally{recovered.close();}}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('batch deletion public methods are typed, read-only classification is precise and handshake is versioned',()=>{
 expect(HOST_PROTOCOL_VERSION).toBe('medclaw.host/p13-v1');expect(DATABASE_SCHEMA_VERSION).toBe(12);
 for(const method of ['data.delete.preview','data.delete.commit','data.delete.read','data.delete.recover'])expect(Object.hasOwn(publicMethodSchemas,method)).toBe(true);
 expect(isReadOnlyMethod('data.delete.read')).toBe(true);expect(isReadOnlyMethod('data.delete.preview')).toBe(false);expect(isReadOnlyMethod('data.delete.recover')).toBe(false);
});
