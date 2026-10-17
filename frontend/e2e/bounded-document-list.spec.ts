import { expect, test } from "./fixtures";

test("document list reads canonical pages even when the provider snapshot is empty", async ({
  page
}) => {
  const requested: Record<string, unknown>[] = [];
  let activePages = 0,
    peakPages = 0;
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
        if (request.command === "system.capabilities") result = ["document.page"];
        else if (request.command === "document.page") {
          requested.push(request.payload);
          const start = Number(request.payload.cursor || 0);
          const end = Math.min(51, start + Number(request.payload.limit));
          result = {
            revision: 4,
            documents: Array.from({ length: end - start }, (_, offset) => {
              const index = start + offset;
              return {
                id: `person:list-${String(index).padStart(2, "0")}`,
                dtype: "person",
                dataset: "fixture",
                schemaVersion: "0.10.1",
                fullName: `Listed ${index}`,
                extensions: {
                  quasarLegacy090: {
                    data: { nested: { text: index === 0 ? "nested needle" : "other" } }
                  }
                }
              };
            }),
            complete: end === 51,
            cursor: end === 51 ? null : String(end)
          };
        } else if (request.command === "dataset.catalog")
          result = {
            revision: 4,
            projection: "dataset-catalog.v1",
            datasets: [],
            complete: true,
            cursor: null
          };
        else
          result = {
            id: request.metadata.workspace,
            revision: 4,
            documentCount: 100000,
            documents: [],
            graphs: []
          };
        const response = JSON.stringify({
          protocol: "quasar.control.v1",
          id: request.id,
          status: "ok",
          result
        });
        if (request.command === "document.page") {
          activePages += 1;
          peakPages = Math.max(peakPages, activePages);
          setTimeout(() => {
            activePages -= 1;
            socket.send(response);
          }, 25);
        } else socket.send(response);
      });
    }
  );
  await page.goto("/documents");
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("person:list-50");
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("nested");
  await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("nested needle");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("person:list-00");
  expect(peakPages).toBe(1);
  expect(
    requested.every(
      (payload) =>
        Number(payload.limit) <= 50 && Number(payload.byteLimit) <= 524288 && !("offset" in payload)
    )
  ).toBe(true);
});
