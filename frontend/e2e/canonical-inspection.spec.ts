import { expect, test } from "./fixtures";

test("inspection and editing resolve an ID absent from the provider snapshot", async ({ page }) => {
  const canonical = {
    id: "person:uncached",
    dtype: "person",
    dataset: "fixture",
    schemaVersion: "0.10.1",
    fullName: "Canonical inspected",
    createdAt: 1,
    updatedAt: 1
  };
  const reads: string[][] = [];
  await page.routeWebSocket(
    (url) => url.port === (process.env.QUASAR_WS_PORT || "8081"),
    (socket) => {
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        let result;
        if (request.command === "graph.catalog") {
          socket.send(
            JSON.stringify({
              protocol: "quasar.control.v1",
              id: request.id,
              status: "ok",
              result: {
                revision: 4,
                projection: "graph-catalog.v1",
                graphs: [],
                complete: true,
                cursor: null
              }
            })
          );
          return;
        }
        if (request.command === "workspace.bootstrap")
          result = {
            id: request.metadata.workspace,
            revision: 4,
            documentCount: 1,
            savedGraphId: null
          };
        else if (request.command === "document.batch") {
          reads.push(request.payload.ids);
          result = { revision: 4, documents: [canonical], missingIds: [] };
        } else if (request.command === "system.capabilities") result = [];
        else result = { id: request.metadata.workspace, revision: 4, documents: [], graphs: [] };
        socket.send(
          JSON.stringify({ protocol: "quasar.control.v1", id: request.id, status: "ok", result })
        );
      });
    }
  );
  await page.goto(`/documents/${encodeURIComponent(canonical.id)}`);
  await expect(
    page.getByRole("heading", { name: "Canonical inspected", exact: true })
  ).toBeVisible();
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("fullName", { exact: true })).toHaveValue("Canonical inspected");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads.every((ids) => ids.length === 1 && ids[0] === canonical.id)).toBe(true);
});
