import { describe, expect, it, vi } from "vitest";
import { startDocumentSource } from "./document-source";

describe("local document source", () => {
  it("hydrates on startup and refreshes from the PouchDB changes feed", async () => {
    let change;
    let documents = [{ _id: "startup" }];
    const load = vi.fn(async () => documents);
    const stop = vi.fn();
    const watch = vi.fn((handler) => {
      change = handler;
      return stop;
    });
    const onDocuments = vi.fn();
    const source = startDocumentSource({ load, watch, onDocuments });

    await source.initial;
    expect(onDocuments).toHaveBeenLastCalledWith([{ _id: "startup" }]);

    documents = [{ _id: "startup" }, { _id: "live-change" }];
    change();
    await vi.waitFor(() => {
      expect(onDocuments).toHaveBeenLastCalledWith(documents);
    });

    source.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not let a slow startup snapshot overwrite a newer live refresh", async () => {
    let change;
    const pending = [];
    const load = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const onDocuments = vi.fn();
    const source = startDocumentSource({
      load,
      watch: (handler) => {
        change = handler;
        return vi.fn();
      },
      onDocuments
    });

    change();
    pending[1]([{ _id: "newer-live-snapshot" }]);
    await vi.waitFor(() => {
      expect(onDocuments).toHaveBeenCalledWith([{ _id: "newer-live-snapshot" }]);
    });
    pending[0]([{ _id: "stale-startup-snapshot" }]);
    await source.initial;

    expect(onDocuments).toHaveBeenCalledTimes(1);
    source.stop();
  });
});
