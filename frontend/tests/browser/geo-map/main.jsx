import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { GeoWorkspace } from "../../../src/components/MapPage";
import "../../../src/styles.css";
import "../../../src/ui-core/shell.css";

const point = {
  id: "point:1",
  longitude: 0,
  latitude: 0,
  participationKind: "direct",
  accuracyMeters: "20"
};
window.geoHarness = { calls: [], defer: false, pending: [], denied: false, revision: 1 };
async function request(command, payload) {
  const harness = window.geoHarness;
  harness.calls.push({ command, payload });
  if (harness.denied) throw new Error("security.forbidden: Geo access denied");
  let result;
  if (command === "geo.viewport")
    result = {
      cells: [{ id: "14/1/1", count: 105, bbox: [-0.01, -0.01, 0.01, 0.01] }],
      depth: 14,
      complete: true
    };
  if (command === "geo.points")
    result = {
      points: [{ ...point, id: payload.cursor ? "point:2" : "point:1" }],
      cursor: payload.cursor ? null : "synthetic-continuation",
      complete: !!payload.cursor,
      performance: { stopReason: "records" }
    };
  if (command === "geo.resolve")
    result = {
      anchors: [
        {
          ...point,
          document: payload.id,
          anchor: "point:1",
          participationKind: "anchored",
          relationPath: [
            { source: payload.id, target: "point:1", via: "relation:1", predicate: "locatedAt" }
          ]
        }
      ],
      complete: true
    };
  if (command === "geo.related")
    result = {
      relations: [
        { source: "report:1", target: "point:1", via: "relation:1", predicate: "locatedAt" }
      ],
      complete: true
    };
  if (command === "document.batch")
    result = {
      documents: [
        { id: payload.ids[0], dtype: "document", dataset: "synthetic", schemaVersion: "0.10.1" }
      ]
    };
  result = { ...result, revision: harness.revision };
  if (harness.defer && (command === "geo.resolve" || command === "geo.points"))
    return new Promise((resolve) => harness.pending.push(() => resolve(result)));
  return result;
}
createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <GeoWorkspace
      request={request}
      tileTemplate={
        new URLSearchParams(location.search).has("tiles") ? "/test-tiles/{z}/{x}/{y}.png" : ""
      }
    />
  </BrowserRouter>
);
