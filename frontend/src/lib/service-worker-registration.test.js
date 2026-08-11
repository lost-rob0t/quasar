import { describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./service-worker-registration";

describe("service worker registration", () => {
  it("bypasses HTTP cache for update checks and reloads when an old controller is replaced", async () => {
    let controllerChange;
    const update = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn().mockResolvedValue({ update });
    const serviceWorker = {
      controller: {},
      register,
      addEventListener: vi.fn((name, handler) => {
        if (name === "controllerchange") controllerChange = handler;
      })
    };
    const reload = vi.fn();

    await registerServiceWorker({ serviceWorker, baseUrl: "/quasar-ui/", reload });
    expect(register).toHaveBeenCalledWith("/quasar-ui/sw.js", {
      type: "module",
      updateViaCache: "none"
    });
    expect(update).toHaveBeenCalledOnce();

    controllerChange();
    controllerChange();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload on the first service-worker installation", async () => {
    let controllerChange;
    const serviceWorker = {
      controller: null,
      register: vi.fn().mockResolvedValue({ update: vi.fn() }),
      addEventListener: vi.fn((name, handler) => {
        if (name === "controllerchange") controllerChange = handler;
      })
    };
    const reload = vi.fn();

    await registerServiceWorker({ serviceWorker, baseUrl: "/", reload });
    controllerChange();
    expect(reload).not.toHaveBeenCalled();
  });
});
