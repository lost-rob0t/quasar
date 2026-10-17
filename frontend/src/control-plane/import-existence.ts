import type { ControlPlaneClient } from "./client";
import { withMutationBase } from "./mutation-base";
import { withWorkspaceScope } from "./workspace-scope";
/** Discard canonical bodies after each bounded lookup; retain only incoming IDs. */
export function existingImportIds(
  client: Pick<ControlPlaneClient, "send" | "onConnectionStateChange">,
  ids: string[]
) {
  return withWorkspaceScope(client, async (check) => {
    const existing = new Map<string, boolean>();
    let revision: number | undefined;
    for (let offset = 0; offset < ids.length; offset += 50) {
      check();
      await withMutationBase(client, ids.slice(offset, offset + 50), async (base) => {
        check();
        if (revision !== undefined && revision !== base.revision)
          throw new Error("Import existence lookup changed revision. Retry the import.");
        revision = base.revision;
        for (const id of base.documents.keys()) existing.set(id, true);
      });
    }
    check();
    return existing;
  });
}
