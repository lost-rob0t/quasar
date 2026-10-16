import type { ControlPlaneClient } from "./client";
import { ControlPlaneError } from "./protocol";

type Client = Pick<ControlPlaneClient, "send" | "onConnectionStateChange">;
/** Retain only the explicit transaction's touched records for ordered undo. */
export async function withMutationBase<T>(
  client: Client,
  requestedIds: string[],
  apply: (base: { revision: number; documents: Map<string, Record<string, unknown>> }) => Promise<T>
): Promise<T> {
  const ids = [...new Set(requestedIds)];
  if (ids.length > 1000 || ids.some((id) => typeof id !== "string" || !id || id.length > 512))
    throw new ControlPlaneError(
      "query.invalid",
      "Mutation lookup exceeds the transaction ID budget."
    );
  let valid = true;
  const unsubscribe = client.onConnectionStateChange((state) => {
    if (!state.synchronized) valid = false;
  });
  const check = () => {
    if (!valid) throw new ControlPlaneError("query.cancelled", "Mutation workspace changed.");
  };
  try {
    check();
    const { revision } = await client.send<{ revision: number }>("workspace.bootstrap", {});
    check();
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new ControlPlaneError("protocol.invalid-envelope", "Invalid mutation revision.");
    const documents = new Map<string, Record<string, unknown>>();
    const read = async (batch: string[]): Promise<void> => {
      check();
      let result: { revision: number; documents: Record<string, unknown>[]; missingIds: string[] };
      try {
        result = await client.send("document.batch", {
          ids: batch,
          expectedRevision: revision,
          byteLimit: 524288
        });
      } catch (error) {
        check();
        if (
          batch.length > 1 &&
          error instanceof ControlPlaneError &&
          ["query.record-too-large", "query.deadline"].includes(error.code)
        ) {
          const middle = Math.ceil(batch.length / 2);
          await read(batch.slice(0, middle));
          await read(batch.slice(middle));
          return;
        }
        throw error;
      }
      check();
      if (result.revision !== revision)
        throw new ControlPlaneError("query.stale-cursor", "Mutation lookup revision changed.");
      if (
        new TextEncoder().encode(JSON.stringify(result)).byteLength > 524288 ||
        !Array.isArray(result.documents) ||
        !Array.isArray(result.missingIds)
      )
        throw new ControlPlaneError("protocol.invalid-envelope", "Invalid mutation lookup batch.");
      const outstanding = new Set(batch);
      for (const document of result.documents) {
        if (
          document?.schemaVersion !== "0.10.1" ||
          typeof document.id !== "string" ||
          !outstanding.delete(document.id)
        )
          throw new ControlPlaneError(
            "protocol.invalid-envelope",
            "Unexpected canonical mutation record."
          );
        documents.set(document.id, document);
      }
      for (const id of result.missingIds) {
        if (!outstanding.delete(id))
          throw new ControlPlaneError(
            "protocol.invalid-envelope",
            "Unexpected missing mutation ID."
          );
      }
      if (outstanding.size)
        throw new ControlPlaneError(
          "protocol.invalid-envelope",
          "Mutation lookup omitted requested IDs."
        );
    };
    for (let offset = 0; offset < ids.length; offset += 50)
      await read(ids.slice(offset, offset + 50));
    check();
    return await apply({ revision, documents });
  } finally {
    unsubscribe();
  }
}
