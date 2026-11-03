export const MERCATOR_LIMIT = 85.0511287798066;
export const wrapLongitude = (longitude) => ((((longitude + 180) % 360) + 360) % 360) - 180;
export const clampLatitude = (latitude) =>
  Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, latitude));

export function worldPoint(longitude, latitude, zoom) {
  const size = 256 * 2 ** zoom;
  const radians = (clampLatitude(latitude) * Math.PI) / 180;
  return [
    ((longitude + 180) / 360) * size,
    ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * size
  ];
}

export function worldCoordinate(x, y, zoom) {
  const size = 256 * 2 ** zoom;
  return [
    wrapLongitude((x / size) * 360 - 180),
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI
  ];
}

export function viewBounds(view, width, height) {
  const size = 256 * 2 ** view.zoom;
  const [x, y] = worldPoint(view.longitude, view.latitude, view.zoom);
  const west = width >= size ? -180 : worldCoordinate(x - width / 2, y, view.zoom)[0];
  const east = width >= size ? 180 : worldCoordinate(x + width / 2, y, view.zoom)[0];
  return [
    west,
    worldCoordinate(x, Math.min(size, y + height / 2), view.zoom)[1],
    east,
    worldCoordinate(x, Math.max(0, y - height / 2), view.zoom)[1]
  ];
}

export function screenPoint(longitude, latitude, view, width, height) {
  const size = 256 * 2 ** view.zoom;
  const [cx, cy] = worldPoint(view.longitude, view.latitude, view.zoom);
  const [x, y] = worldPoint(longitude, latitude, view.zoom);
  let delta = x - cx;
  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;
  return [width / 2 + delta, height / 2 + y - cy];
}

export function panView(view, dx, dy) {
  const [x, y] = worldPoint(view.longitude, view.latitude, view.zoom);
  const size = 256 * 2 ** view.zoom;
  const [longitude, latitude] = worldCoordinate(
    x - dx,
    Math.max(0, Math.min(size, y - dy)),
    view.zoom
  );
  return { ...view, longitude, latitude };
}

export function normalizeView(view = {}) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    longitude: wrapLongitude(number(view.longitude, 0)),
    latitude: clampLatitude(number(view.latitude, 20)),
    zoom: Math.round(Math.max(1, Math.min(22, number(view.zoom, 2))))
  };
}

export function localTileTemplate(value, origin) {
  if (
    !value ||
    typeof value !== "string" ||
    !["{z}", "{x}", "{y}"].every((key) => value.includes(key))
  )
    return null;
  try {
    const url = new URL(
      value.replaceAll("{z}", "1").replaceAll("{x}", "1").replaceAll("{y}", "1"),
      origin
    );
    // Deployment-owned OSM tiles only. Neither document IDs nor query strings
    // are ever sent to an external map/geocoding service.
    return url.origin === origin && !url.username && !url.password && !url.search && !url.hash
      ? value
      : null;
  } catch {
    return null;
  }
}

export function visibleTiles(view, width, height, template) {
  if (!template) return [];
  const n = 2 ** view.zoom;
  const [cx, cy] = worldPoint(view.longitude, view.latitude, view.zoom);
  const left = cx - width / 2;
  const top = cy - height / 2;
  const tiles = [];
  for (let x = Math.floor(left / 256); x <= Math.floor((left + width) / 256); x += 1) {
    for (
      let y = Math.max(0, Math.floor(top / 256));
      y <= Math.min(n - 1, Math.floor((top + height) / 256));
      y += 1
    ) {
      if (tiles.length >= 96) return tiles;
      const column = ((x % n) + n) % n;
      tiles.push({
        key: `${x}/${y}`,
        left: x * 256 - left,
        top: y * 256 - top,
        url: template
          .replaceAll("{z}", String(view.zoom))
          .replaceAll("{x}", String(column))
          .replaceAll("{y}", String(y))
      });
    }
  }
  return tiles;
}

// Last request wins; callers discard all prior page/selection data on movement.
export function createGeoRequestGate() {
  let generation = 0;
  return {
    next: () => ++generation,
    current: (ticket) => generation === ticket,
    cancel: () => {
      generation += 1;
    }
  };
}
