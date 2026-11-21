import { describe, expect, it, vi, afterEach } from "vitest";
import { createDocument } from "./canonical-document";
import { createActorSubmission, readActorDocument, submissionStorageKey } from "./actor-submission";

const configuration = { serverUrl: "http://127.0.0.1:5000", serverToken: "synthetic-token" };
const actor = {
  actorId: "synthetic",
  serverManaged: true,
  resourceKind: "actor",
  alive: true,
  accepts: { targets: ["string"] }
};
function memoryStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key),
    setItem: (key, value) => entries.set(key, value),
    removeItem: (key) => entries.delete(key)
  };
}
const receipt = {
  status: "accepted",
  target_id: "target:server",
  request_id: "target-request:server"
};
afterEach(() => vi.unstubAllGlobals());

describe("recoverable server actor submission", () => {
  it("persists before POST, recovers after a lost response and restart, and does not repeat accepted work", async () => {
    const storage = memoryStorage();
    const accepted = new Map();
    const fetch = vi.fn(async (_url, options) => {
      const command = JSON.parse(options.body);
      expect(JSON.parse(storage.getItem("scope")).target.id).toBe(command.idempotency_key);
      if (!accepted.has(command.idempotency_key)) {
        accepted.set(command.idempotency_key, command);
        throw new TypeError("Disconnected after acceptance");
      }
      expect(command).toEqual(accepted.get(command.idempotency_key));
      return Response.json({ ...receipt, status: "duplicate" });
    });
    vi.stubGlobal("fetch", fetch);
    const first = createActorSubmission({ configuration, storage, key: "scope" });
    await expect(first.submit(actor, "fixture.invalid", "synthetic")).rejects.toThrow(
      "Disconnected"
    );
    const restarted = createActorSubmission({ configuration, storage, key: "scope" });
    expect(restarted.getState().phase).toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(1); // construction never sends
    await restarted.submit();
    expect(restarted.getState().receipt).toEqual({
      status: "duplicate",
      targetId: receipt.target_id,
      requestId: receipt.request_id
    });
    await restarted.submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(accepted.size).toBe(1);
    expect(restarted.getState().phase).toBe("accepted");
    expect(JSON.stringify(restarted.getState())).not.toContain("completed");
  });

  it("blocks rapid duplicate clicks while preserving a single request", async () => {
    let finish;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal("fetch", fetch);
    const controller = createActorSubmission({
      configuration,
      storage: memoryStorage(),
      key: "scope"
    });
    const pending = controller.submit(actor, "fixture.invalid", "synthetic");
    await expect(controller.submit(actor, "fixture.invalid", "synthetic")).rejects.toThrow(
      "already in progress"
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    finish(Response.json(receipt));
    await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send if durable recovery storage fails", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      }
    };
    await expect(
      createActorSubmission({ configuration, storage, key: "scope" }).submit(actor, "x", "test")
    ).rejects.toThrow("quota");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 500])(
    "does not fall back or automatically retry HTTP %i",
    async (status) => {
      const fetch = vi.fn(async () => Response.json({ message: "rejected" }, { status }));
      vi.stubGlobal("fetch", fetch);
      const controller = createActorSubmission({
        configuration,
        storage: memoryStorage(),
        key: "scope"
      });
      await expect(controller.submit(actor, "x", "test")).rejects.toThrow("rejected");
      expect(controller.getState().phase).toBe("unknown");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a malformed receipt without claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "ok" }))
    );
    const controller = createActorSubmission({
      configuration,
      storage: memoryStorage(),
      key: "scope"
    });
    await expect(controller.submit(actor, "x", "test")).rejects.toThrow("outcome unknown");
    expect(controller.getState().receipt).toBeNull();
  });

  it("isolates saved submissions by server, principal and workspace without retaining credentials", async () => {
    const key = await submissionStorageKey(configuration, "one");
    expect(key).not.toContain(configuration.serverToken);
    expect(
      await submissionStorageKey(
        { ...configuration, serverUrl: configuration.serverUrl + "/" },
        "one"
      )
    ).toBe(key);
    expect(await submissionStorageKey(configuration, "two")).not.toBe(key);
    expect(await submissionStorageKey({ ...configuration, serverToken: "other" }, "one")).not.toBe(
      key
    );
    expect(
      await submissionStorageKey({ ...configuration, serverUrl: "http://127.0.0.1:5001" }, "one")
    ).not.toBe(key);
  });

  it("reads only the exact requested document and rejects an identity mismatch", async () => {
    const document = createDocument("target", {
      id: "target:server",
      actor: "synthetic",
      target: "x",
      dataset: "synthetic"
    });
    const fetch = vi.fn(async () => Response.json(document));
    vi.stubGlobal("fetch", fetch);
    expect(await readActorDocument(configuration, document.id)).toMatchObject({ id: document.id });
    expect(fetch.mock.calls[0][0]).toBe("http://127.0.0.1:5000/api/v1/documents/target%3Aserver");
    await expect(readActorDocument(configuration, "target:other")).rejects.toThrow(
      "different document ID"
    );
  });
});
