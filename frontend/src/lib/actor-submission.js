import { createDocument, toCanonicalDocument } from "./canonical-document";
import { requestStarIntel, submitTargetToServer } from "./starintel-server";

export async function submissionStorageKey(configuration, workspace = "default") {
  // Isolate receipts by endpoint, workspace and authentication identity, without storing credentials.
  const identity = JSON.stringify([
    String(configuration.serverUrl || "")
      .trim()
      .replace(/\/+$/, ""),
    workspace,
    configuration.serverUsername || "",
    configuration.serverToken || ""
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return `quasar-actor-submission:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function receiptFrom(response) {
  if (
    !["accepted", "duplicate"].includes(response?.status) ||
    ![response.target_id, response.request_id].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 512
    )
  )
    throw new Error("Server did not return a valid Target acceptance receipt; outcome unknown");
  return { status: response.status, targetId: response.target_id, requestId: response.request_id };
}

export async function readActorDocument(configuration, id) {
  if (typeof id !== "string" || !id.trim() || id.length > 512)
    throw new Error("A server document ID is required");
  const body = await requestStarIntel(configuration, `/api/v1/documents/${encodeURIComponent(id)}`);
  const document = toCanonicalDocument(body, { allowLegacy090: true });
  if (document.id !== id) throw new Error("Server returned a different document ID");
  return document;
}

// One recoverable submission per scope. No automatic POST on mount/reconnect.
// Server acceptance is deliberately never promoted to execution/completion.
export function createActorSubmission({ configuration, storage, key, onChange = () => {} }) {
  let state = null;
  let busy = false;
  const stored = storage.getItem(key);
  if (stored) {
    const parsed = JSON.parse(stored);
    if (parsed.version !== 1) throw new Error("Unsupported saved submission version");
    const target = toCanonicalDocument(parsed.target);
    if (target.dtype !== "target") throw new Error("Saved submission is not a Target");
    state = {
      version: 1,
      target,
      receipt: parsed.receipt
        ? receiptFrom({
            status: parsed.receipt.status,
            target_id: parsed.receipt.targetId,
            request_id: parsed.receipt.requestId
          })
        : null,
      phase: parsed.receipt ? "accepted" : "unknown"
    };
  }
  function update(next) {
    // If durable browser storage fails, do not send the request.
    storage.setItem(key, JSON.stringify(next));
    state = next;
    onChange(state);
  }
  return {
    getState: () => state,
    async submit(actor, subject, dataset) {
      if (busy) throw new Error("A submission is already in progress");
      if (state?.receipt) return state.receipt;
      if (!state) {
        if (
          !actor?.serverManaged ||
          actor.resourceKind !== "actor" ||
          !actor.alive ||
          !actor.accepts?.targets?.length
        ) {
          throw new Error("Choose a ready server actor that accepts Targets");
        }
        if (!subject.trim() || !dataset.trim()) throw new Error("Target and dataset are required");
        update({
          version: 1,
          phase: "unknown",
          receipt: null,
          target: createDocument("target", {
            id: `target:${crypto.randomUUID()}`,
            actor: actor.actorId,
            target: subject.trim(),
            dataset: dataset.trim(),
            delay: 1,
            recurring: false,
            options: {}
          })
        });
      }
      busy = true;
      try {
        const receipt = receiptFrom(await submitTargetToServer(configuration, state.target));
        update({ ...state, phase: "accepted", receipt });
        return receipt;
      } finally {
        busy = false;
      }
    },
    clear() {
      if (busy) throw new Error("Wait for the current submission");
      storage.removeItem(key);
      state = null;
      onChange(null);
    }
  };
}
