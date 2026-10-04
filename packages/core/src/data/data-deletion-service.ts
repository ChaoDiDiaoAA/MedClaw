import {serviceResult,safeError,type Result} from '../../../contracts/src/error';
import {canonicalRequest} from '../../../contracts/src/run';
import {DataDeletePreviewRequestSchema,DataDeleteCommitRequestSchema,type DataDeletePreviewRequest,type DataDeleteCommitRequest,type DataDeleteOperation} from '../../../contracts/src/data-deletion';
import {SqliteDataDeletionStore} from '../../../storage/src/data-deletion-store';
import {ArtifactStore} from '../../../storage/src/artifact-store';

export class DataDeletionService {
 private closing=false;
 private readonly active=new Map<string,{key:string;promise:Promise<Result<DataDeleteOperation>>}>();
 constructor(private readonly store:SqliteDataDeletionStore,private readonly artifacts:ArtifactStore,private readonly instanceId:string){}
 private execute(operationRef:string,key:string,action:()=>Promise<DataDeleteOperation>){
  const prior=this.active.get(operationRef);if(prior)return prior.key===key?prior.promise:serviceResult<DataDeleteOperation>(()=>{throw new Error('state_conflict');},'storage_write_failed');
  const promise=serviceResult(async()=>{if(this.closing)throw new Error('host_interrupted');return action();},'storage_write_failed',{operationRef});
  this.active.set(operationRef,{key,promise});void promise.finally(()=>{if(this.active.get(operationRef)?.promise===promise)this.active.delete(operationRef);});return promise;
 }
 preview(raw:DataDeletePreviewRequest){return this.execute(raw.operationRef,`preview:${canonicalRequest(raw)}`,async()=>{
   const input=DataDeletePreviewRequestSchema.parse(raw),prior=this.store.read(input.operationRef);
   if(prior)return this.store.preview(input,this.instanceId,new Date().toISOString(),[]);
   this.store.assertIdle();const generation=this.store.importGeneration(),ids=this.store.targetIds(input);
   const files=await this.artifacts.planBatchDeletion(ids);if(this.closing)throw new Error('host_interrupted');
   return this.store.preview(input,this.instanceId,new Date().toISOString(),files,generation);
 });}
 commit(raw:DataDeleteCommitRequest){return this.execute(raw.operationRef,`commit:${canonicalRequest(raw)}`,async()=>{
   const input=DataDeleteCommitRequestSchema.parse(raw),prior=this.store.read(input.operationRef);if(!prior)throw new Error('operation_not_found');
   if(prior.state==='committed')return this.store.commit(input,new Date().toISOString());
   this.store.assertIdle(input.operationRef);
   const generation=this.store.importGeneration(),files=await this.artifacts.planBatchDeletion(prior.preview.batches.map(batch=>batch.id));
   const ordered=(items:typeof files)=>[...items].sort((a,b)=>a.artifactId-b.artifactId||a.path.localeCompare(b.path));
   if(canonicalRequest(ordered(files))!==canonicalRequest(prior.preview.files))throw new Error('state_conflict');
   for(const id of new Set(prior.preview.files.map(file=>file.artifactId)))await this.artifacts.assertDeletionOwner(id);
   if(this.closing)throw new Error('host_interrupted');
   return this.cleanup(this.store.commit(input,new Date().toISOString(),generation));
 });}
 read(operationRef:string){return serviceResult(()=>this.store.read(operationRef),'storage_read_failed',{operationRef});}
 recover(operationRef:string){return this.execute(operationRef,'recover',async()=>{this.store.assertIdle(operationRef);const operation=this.store.read(operationRef);if(!operation||operation.state!=='committed')throw new Error('state_conflict');return this.cleanup(operation);});}
 private async cleanup(operation:DataDeleteOperation){
   if(operation.cleanup.state==='complete')return operation;
   let completed=0;
   try{for(const file of operation.preview.files){if(this.closing)throw new Error('host_interrupted');await this.artifacts.deleteManagedFile(file,operation.operationRef);completed++;}
     return this.store.saveCleanup(operation.operationRef,{state:'complete',remainingCount:0,error:null},new Date().toISOString());
   }catch{return this.store.saveCleanup(operation.operationRef,{state:'failed',remainingCount:operation.preview.files.length-completed,error:safeError('storage_write_failed')},new Date().toISOString());}
 }
 async shutdown(){this.closing=true;await Promise.all([...this.active.values()].map(operation=>operation.promise));}
}
