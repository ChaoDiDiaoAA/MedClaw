import type { Database } from 'bun:sqlite';
import type { WriteTransactions } from '../../contracts/src/event';
type Frame=Map<string|symbol,()=>void>;
const stacks=new WeakMap<Database,Frame[]>();
const wrappers=new WeakMap<Database,SqliteWriteTransactions>();
export class SqliteWriteTransactions implements WriteTransactions {
 static forDatabase(db:Database):SqliteWriteTransactions {let tx=wrappers.get(db);if(!tx){tx=new SqliteWriteTransactions(db);wrappers.set(db,tx);}return tx;}
 constructor(private readonly db:Database) {if(!stacks.has(db))stacks.set(db,[]);}
 immediate<T>(action:()=>T):T {
  const frames=stacks.get(this.db)!;
  if(frames.length===0&&this.db.inTransaction)throw new Error('state_conflict');
  const frame:Frame=new Map();frames.push(frame);let value:T;
  try{value=this.db.transaction(()=>{const result=action();if(result!==null&&(typeof result==='object'||typeof result==='function')&&typeof (result as {then?:unknown}).then==='function')throw new Error('invalid_argument');return result;}).immediate();}
  catch(error){frames.pop();throw error;}
  frames.pop();const parent=frames.at(-1);
  if(parent){for(const [key,callback] of frame)parent.set(key,callback);}
  else for(const callback of frame.values()){try{callback();}catch{/* Commit already succeeded; callback owners report safe diagnostics. */}}
  return value;
 }
 afterCommit(action:()=>void,key?:string):void {this.assertActive();stacks.get(this.db)!.at(-1)!.set(key??Symbol(),action);}
 assertActive():void {if(!this.db.inTransaction||!stacks.get(this.db)?.length)throw new Error('state_conflict');}
}
