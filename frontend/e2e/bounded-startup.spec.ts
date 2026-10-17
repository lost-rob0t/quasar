import { expect, test } from "./fixtures";
test("home bootstraps 100k documents without requesting the saved graph or a corpus", async ({
  page
}) => {
  const commands: string[] = [];
  await page.routeWebSocket(
    (url) => url.port === (process.env.QUASAR_WS_PORT || "8081"),
    (socket) => {
      socket.onMessage((raw) => {
        const request = JSON.parse(String(raw));
        commands.push(request.command);
        const result =
          request.command === "system.capabilities"
            ? []
            : request.command === "graph.catalog"
              ? {
                  revision: 4,
                  projection: "graph-catalog.v1",
                  graphs: [
                    {
                      id: "huge",
                      name: "Saved huge graph",
                      membershipMode: "all",
                      documentCount: 100000,
                      nodeCount: 100000,
                      edgeCount: 0
                    }
                  ],
                  savedGraphId: "huge",
                  complete: true,
                  cursor: null
                }
              : {
                  id: request.metadata.workspace,
                  revision: 4,
                  documentCount: 100000,
                  savedGraphId: "huge"
                };
        socket.send(
          JSON.stringify({ protocol: "quasar.control.v1", id: request.id, status: "ok", result })
        );
      });
    }
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "100,000 documents in the workspace" })
  ).toBeVisible();
  expect(commands).toContain("workspace.bootstrap");
  expect(commands).toContain("graph.catalog");
  expect(
    commands.filter((command) =>
      [
        "workspace.snapshot",
        "document.list",
        "document.page",
        "document.batch",
        "graph.page",
        "graph.snapshot"
      ].includes(command)
    )
  ).toEqual([]);
  await expect(page.locator(".notice-error")).toHaveCount(0);
});
