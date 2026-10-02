import { serviceResult } from "../../../contracts/src/error";
import type { SessionStore } from "../../../contracts/src/session";
import { WorkspaceChangeSchema, RevisionSchema, type WorkspaceChange } from "../../../contracts/src/workspace";

export class WorkspaceService {
  constructor(private readonly store: Pick<SessionStore, "readWorkspace" | "readSession" | "updateWorkspace">) {}
  read() { return serviceResult(() => this.store.readWorkspace(), "storage_read_failed"); }
  update(change: WorkspaceChange, expectedRevision: number) {
    return serviceResult(() => this.store.updateWorkspace(WorkspaceChangeSchema.parse(change), RevisionSchema.parse(expectedRevision), new Date().toISOString()), "storage_write_failed");
  }
  restore() {
    return serviceResult(() => {
      const workspace = this.store.readWorkspace();
      if (workspace.sessionId !== null && !this.store.readSession(workspace.sessionId)) throw new Error("storage_read_failed");
      return workspace;
    }, "storage_read_failed");
  }
}
