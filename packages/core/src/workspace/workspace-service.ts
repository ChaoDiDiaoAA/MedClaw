import { serviceResult } from "../../../contracts/src/error";
import type { SessionStore } from "../../../contracts/src/session";

export class WorkspaceService {
  constructor(private readonly store: Pick<SessionStore, "readWorkspace" | "readSession">) {}
  read() { return serviceResult(() => this.store.readWorkspace(), "storage_read_failed"); }
  restore() {
    return serviceResult(() => {
      const workspace = this.store.readWorkspace();
      if (workspace.sessionId !== null && !this.store.readSession(workspace.sessionId)) throw new Error("storage_read_failed");
      return workspace;
    }, "storage_read_failed");
  }
}
