import { safeError, serviceResult } from "../../../contracts/src/error";
import { WorkspaceChangeSchema, RevisionSchema, type WorkspaceChange, type WorkspaceStore, type WorkspaceView, type ManagedImportInspection } from "../../../contracts/src/workspace";
import {isDeepStrictEqual} from 'node:util';

export class WorkspaceService {
  constructor(private readonly store: WorkspaceStore,
    private readonly artifacts?: { inspectManagedImport(id: number): Promise<ManagedImportInspection> },private readonly assertWritable:()=>void=()=>{}) {}
  read() { return serviceResult(() => this.store.readWorkspace(), "storage_read_failed"); }
  update(change: WorkspaceChange, expectedRevision: number) {
    return serviceResult(() => {this.assertWritable();return this.store.updateWorkspace(WorkspaceChangeSchema.parse(change), RevisionSchema.parse(expectedRevision), new Date().toISOString());}, "storage_write_failed");
  }
  restore() {
    return serviceResult<WorkspaceView>(async () => {
      this.assertWritable();
      const original = this.store.inspectWorkspace();
      const invalid: number[] = [];
      for (const id of new Set(original.artifactIds)) {
        if (!this.artifacts) throw new Error('artifact_not_ready');
        const inspection = await this.artifacts.inspectManagedImport(id);
        if (inspection.status === 'unavailable') throw new Error(inspection.reason === 'storage_unavailable' ? 'storage_read_failed' : 'artifact_not_ready');
        if (inspection.status === 'invalid') invalid.push(id);
      }
      const checked = this.store.inspectWorkspace(invalid);
      if (checked.state.revision !== original.state.revision || !isDeepStrictEqual(checked.dependencies,original.dependencies))
        throw safeError('state_conflict', undefined, {reason:'workspace_revision_mismatch'});
      this.assertWritable();
      const saved = this.store.commitWorkspaceRestore(original.state.revision, original.dependencies, checked.candidate, new Date().toISOString());
      return checked.notices.length ? {...saved,notices:checked.notices} : saved;
    }, "storage_read_failed");
  }
}
