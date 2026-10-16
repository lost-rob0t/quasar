import { expect, test } from "./fixtures";

declare global {
  interface Window {
    exportFixture: { writes: string[]; closed: number; aborted: number; release?: () => void };
  }
}

for (const holdClose of [false, true]) {
  test(`workspace export streams through the production UI${holdClose ? " and cancels during close" : ""}`, async ({
    page
  }) => {
    // Synthetic transport/file fixtures exercise real React/provider/client wiring.
    // Backend paging and native OS file dialogs are covered separately.
    await page.addInitScript((hold) => {
      window.exportFixture = { writes: [], closed: 0, aborted: 0 };
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => ({
          createWritable: async () => ({
            write: async (text: string) => {
              window.exportFixture.writes.push(text);
            },
            close: async () => {
              if (hold)
                await new Promise<void>((resolve) => {
                  window.exportFixture.release = resolve;
                });
              window.exportFixture.closed += 1;
            },
            abort: async () => {
              window.exportFixture.aborted += 1;
            }
          })
        })
      });
    }, holdClose);
    const commands: string[] = [];
    await page.routeWebSocket(
      (url) => url.port === (process.env.QUASAR_WS_PORT || "8081"),
      (socket) => {
        socket.onMessage((raw) => {
          const request = JSON.parse(String(raw));
          commands.push(request.command);
          const result =
            request.command === "system.capabilities"
              ? ["document.page"]
              : request.command === "document.page"
                ? {
                    revision: 4,
                    documents: request.payload.cursor
                      ? []
                      : [{ id: "fixture:a", schemaVersion: "0.10.1", dtype: "person" }],
                    complete: Boolean(request.payload.cursor),
                    cursor: request.payload.cursor ? null : "next"
                  }
                : { id: request.metadata.workspace, revision: 4, documents: [], graphs: [] };
          socket.send(
            JSON.stringify({ protocol: "quasar.control.v1", id: request.id, status: "ok", result })
          );
        });
      }
    );
    await page.goto("/documents");
    await expect.poll(() => commands.includes("workspace.snapshot")).toBe(true);
    await page.getByRole("button", { name: "Export workspace", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.exportFixture.writes.length)).toBe(1);
    if (holdClose) {
      await expect
        .poll(() => page.evaluate(() => Boolean(window.exportFixture.release)))
        .toBe(true);
      await page.getByRole("button", { name: "Cancel export", exact: true }).click();
      await page.evaluate(() => window.exportFixture.release?.());
      await expect.poll(() => page.evaluate(() => window.exportFixture.aborted)).toBe(1);
      await expect(page.getByText("Exported 1 canonical documents", { exact: false })).toHaveCount(
        0
      );
    } else {
      await expect(
        page.getByText("Exported 1 canonical documents at workspace revision 4.", { exact: true })
      ).toBeVisible();
      expect(await page.evaluate(() => window.exportFixture.closed)).toBe(1);
      expect(await page.evaluate(() => window.exportFixture.aborted)).toBe(0);
    }
    expect(commands.filter((command) => command === "document.page")).toHaveLength(2);
    expect(await page.evaluate(() => window.exportFixture.writes[0])).toBe(
      '{"id":"fixture:a","schemaVersion":"0.10.1","dtype":"person"}\n'
    );
  });
}
