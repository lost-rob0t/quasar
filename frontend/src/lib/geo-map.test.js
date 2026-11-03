import { describe, expect, it } from "vitest";
import {
  clampLatitude,
  createGeoRequestGate,
  localTileTemplate,
  normalizeView,
  panView,
  screenPoint,
  viewBounds,
  visibleTiles,
  worldCoordinate,
  worldPoint,
  wrapLongitude
} from "./geo-map";

describe("OSM map coordinates and request bounds", () => {
  it("round trips WGS84 and clamps Web Mercator poles", () => {
    for (const [lon, lat] of [
      [0, 0],
      [179.9, -42],
      [-179.9, 70],
      [-83, 40]
    ]) {
      const actual = worldCoordinate(...worldPoint(lon, lat, 17), 17);
      expect(actual[0]).toBeCloseTo(lon, 8);
      expect(actual[1]).toBeCloseTo(lat, 8);
    }
    expect(clampLatitude(90)).toBeLessThan(86);
    expect(wrapLongitude(180)).toBe(-180);
    expect(normalizeView({ longitude: Infinity, latitude: NaN, zoom: 999 })).toEqual({
      longitude: 0,
      latitude: 20,
      zoom: 22
    });
  });
  it("sends wrapped antimeridian boxes and full world coverage", () => {
    const bounds = viewBounds({ longitude: 179, latitude: 0, zoom: 4 }, 900, 500);
    expect(bounds[0]).toBeGreaterThan(bounds[2]);
    const world = viewBounds({ longitude: 0, latitude: 0, zoom: 1 }, 1200, 900);
    expect(world[0]).toBe(-180);
    expect(world[2]).toBe(180);
    const point = screenPoint(-179, 0, { longitude: 179, latitude: 0, zoom: 4 }, 900, 500);
    expect(point[0]).toBeGreaterThan(450);
    expect(point[0]).toBeLessThan(500);
  });
  it("pans across the date line and limits tile work", () => {
    const view = panView({ longitude: 179, latitude: 0, zoom: 4 }, -100, 0);
    expect(view.longitude).toBeLessThan(-170);
    const tiles = visibleTiles(view, 900, 500, "/osm/{z}/{x}/{y}.png");
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(20);
    expect(tiles.every((tile) => !tile.url.includes("/-"))).toBe(true);
    expect(visibleTiles(view, 1e6, 1e6, "/osm/{z}/{x}/{y}.png")).toHaveLength(96);
    expect(visibleTiles(view, 900, 500, null)).toEqual([]);
  });
  it("accepts local OSM XYZ only, with no query or external transmission", () => {
    const origin = "https://quasar.test";
    expect(localTileTemplate("/osm/{z}/{x}/{y}.png", origin)).toBe("/osm/{z}/{x}/{y}.png");
    for (const value of [
      "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      "//tracker.test/{z}/{x}/{y}",
      "/osm/{z}/{x}/{y}?doc=private",
      "/osm/{z}/{x}/{y}#private",
      "javascript:alert(1)",
      ""
    ]) {
      expect(localTileTemplate(value, origin)).toBeNull();
    }
  });
  it("invalidates late requests, pages and navigation effects", () => {
    const gate = createGeoRequestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    gate.cancel();
    expect(gate.current(second)).toBe(false);
  });
});
