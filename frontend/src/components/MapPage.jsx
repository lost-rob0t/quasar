import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getControlPlane } from "../control-plane/client";
import { useQuasar } from "../store";
import {
  createGeoRequestGate,
  localTileTemplate,
  normalizeView,
  panView,
  screenPoint,
  viewBounds,
  visibleTiles
} from "../lib/geo-map";
import "../geo-map.css";

const tileSetting = import.meta.env.VITE_OSM_TILE_TEMPLATE || "";
const sendGeo = (command, payload) => {
  const client = getControlPlane();
  if (!client?.getConnected())
    return Promise.reject(new Error("Connect to the Quasar control plane to query the map."));
  return client.send(command, payload);
};

export function GeoWorkspace({ request = sendGeo, revision = 0, tileTemplate = tileSetting }) {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState(() =>
    normalizeView({
      longitude: params.get("lon") ?? 0,
      latitude: params.get("lat") ?? 20,
      zoom: params.get("z") ?? 2
    })
  );
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [page, setPage] = useState(null);
  const [mode, setMode] = useState("cells");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [relations, setRelations] = useState(null);
  const [document, setDocument] = useState(null);
  const [selectionError, setSelectionError] = useState("");
  const [lookup, setLookup] = useState(params.get("anchor") || "");
  const [resolving, setResolving] = useState(false);
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [tileFailed, setTileFailed] = useState(false);
  const map = useRef(null);
  const drag = useRef(null);
  const pageGate = useRef(createGeoRequestGate());
  const selectionGate = useRef(createGeoRequestGate());
  const lookupGate = useRef(createGeoRequestGate());
  const activePageRequest = useRef(null);
  const bbox = useMemo(() => viewBounds(view, size.width, size.height), [view, size]);
  const template = localTileTemplate(tileTemplate, window.location.origin);
  const tiles = visibleTiles(view, size.width, size.height, template);
  const anchorParam = params.get("anchor");

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(200, entry.contentRect.width),
        height: Math.max(300, entry.contentRect.height)
      });
    });
    observer.observe(map.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    selectionGate.current.cancel();
    setSelected(null);
    setSelectionError("");
  }, [revision]);

  useEffect(() => {
    const ticket = pageGate.current.next();
    setPage(null);
    setError("");
    setBusy(true);
    activePageRequest.current = null;
    const timer = setTimeout(async () => {
      const payload = mode === "cells" ? { bbox, zoom: view.zoom } : { bbox, limit: 100 };
      try {
        const result = await request(mode === "cells" ? "geo.viewport" : "geo.points", payload);
        if (pageGate.current.current(ticket)) {
          setPage(result);
          activePageRequest.current = payload;
        }
      } catch (failure) {
        if (pageGate.current.current(ticket)) setError(failure.message);
      } finally {
        if (pageGate.current.current(ticket)) setBusy(false);
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      pageGate.current.cancel();
    };
  }, [request, bbox, mode, view.zoom, revision]);

  useEffect(() => {
    const ticket = lookupGate.current.next();
    if (!anchorParam) {
      setResolving(false);
      return;
    }
    setResolving(true);
    setSelectionError("");
    request("geo.resolve", { id: anchorParam })
      .then((result) => {
        if (!lookupGate.current.current(ticket)) return;
        if (!result.anchors?.length)
          throw new Error(
            result.complete
              ? "This document has no supported geographic anchor."
              : "No anchor found within the traversal limit."
          );
        const anchor = result.anchors[0];
        setView(
          normalizeView({ longitude: anchor.longitude, latitude: anchor.latitude, zoom: 16 })
        );
        setSelected({ ...anchor, revision: result.revision });
        setLookup(anchorParam);
        if (!result.complete || result.anchors.length > 1)
          setSelectionError("Showing the first anchor. Other anchors or bounded paths may exist.");
      })
      .catch((failure) => {
        if (lookupGate.current.current(ticket)) setSelectionError(failure.message);
      })
      .finally(() => {
        if (lookupGate.current.current(ticket)) setResolving(false);
      });
    return () => lookupGate.current.cancel();
  }, [anchorParam, request, revision, lookupAttempt]);

  useEffect(() => {
    const ticket = selectionGate.current.next();
    setDocument(null);
    setRelations(null);
    if (!selected) return;
    // Fetch canonical details and reference pages through existing session gates.
    const id = selected.document || selected.id;
    Promise.all([
      request("document.batch", { ids: [id], expectedRevision: selected.revision }),
      request("geo.related", { id: selected.anchor || selected.id, limit: 25 })
    ])
      .then(([details, related]) => {
        if (selectionGate.current.current(ticket)) {
          if (details.revision !== related.revision || details.revision !== selected.revision) {
            setSelectionError("Workspace changed; select the document again.");
            return;
          }
          setDocument(details.documents?.[0] || null);
          setRelations(related);
        }
      })
      .catch((failure) => {
        if (selectionGate.current.current(ticket)) setSelectionError(failure.message);
      });
    return () => selectionGate.current.cancel();
  }, [selected, request, revision]);

  useEffect(
    () => () => {
      pageGate.current.cancel();
      selectionGate.current.cancel();
      lookupGate.current.cancel();
    },
    []
  );

  function changeView(next) {
    pageGate.current.cancel();
    selectionGate.current.cancel();
    lookupGate.current.cancel();
    setView(normalizeView(next));
    setSelected(null);
    setSelectionError("");
    const normalized = normalizeView(next);
    setParams(
      {
        lon: String(normalized.longitude),
        lat: String(normalized.latitude),
        z: String(normalized.zoom)
      },
      { replace: true }
    );
  }
  function selectPoint(point) {
    selectionGate.current.cancel();
    lookupGate.current.cancel();
    setResolving(false);
    setParams(
      { lon: String(view.longitude), lat: String(view.latitude), z: String(view.zoom) },
      { replace: true }
    );
    setSelectionError("");
    setSelected({ ...point, revision: page.revision });
  }
  function resolveDocument(id) {
    lookupGate.current.cancel();
    selectionGate.current.cancel();
    setLookupAttempt((attempt) => attempt + 1);
    setSelected(null);
    setSelectionError("");
    setParams({
      anchor: id,
      lon: String(view.longitude),
      lat: String(view.latitude),
      z: String(view.zoom)
    });
  }
  async function nextPage() {
    if (busy || !page?.cursor || !activePageRequest.current) return;
    lookupGate.current.cancel();
    selectionGate.current.cancel();
    setSelected(null);
    setResolving(false);
    setParams(
      { lon: String(view.longitude), lat: String(view.latitude), z: String(view.zoom) },
      { replace: true }
    );
    const ticket = pageGate.current.next();
    setBusy(true);
    setError("");
    try {
      const result = await request("geo.points", {
        ...activePageRequest.current,
        cursor: page.cursor
      });
      if (pageGate.current.current(ticket)) {
        setPage(result);
        setSelected(null);
      }
    } catch (failure) {
      if (pageGate.current.current(ticket)) {
        setPage(null);
        setError(failure.message);
      }
    } finally {
      if (pageGate.current.current(ticket)) setBusy(false);
    }
  }
  async function nextRelations() {
    if (!relations?.cursor || !selected) return;
    const ticket = selectionGate.current.next();
    try {
      const result = await request("geo.related", {
        id: selected.anchor || selected.id,
        limit: 25,
        cursor: relations.cursor
      });
      if (selectionGate.current.current(ticket)) setRelations(result);
    } catch (failure) {
      if (selectionGate.current.current(ticket)) setSelectionError(failure.message);
    }
  }
  function zoomCell(cell) {
    const [west, south, east, north] = cell.bbox;
    const next = normalizeView({
      longitude: (west + east) / 2,
      latitude: (south + north) / 2,
      zoom: Math.min(22, Math.max(view.zoom + 2, page.depth + 2))
    });
    changeView(next);
    if (page.depth === 14) setMode("points");
  }

  function changeMode(next) {
    if (next === mode) return;
    pageGate.current.cancel();
    selectionGate.current.cancel();
    lookupGate.current.cancel();
    setSelected(null);
    setResolving(false);
    setMode(next);
    setParams(
      { lon: String(view.longitude), lat: String(view.latitude), z: String(view.zoom) },
      { replace: true }
    );
  }

  return (
    <section className="geo-workspace" aria-label="Geographic documents">
      <header className="geo-header">
        <div>
          <h1>Geography</h1>
          <p>Explore document locations and explicit geographic relations.</p>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (lookup.trim()) resolveDocument(lookup.trim());
          }}
        >
          <label htmlFor="geo-document-id">Find document on map</label>
          <div>
            <input
              id="geo-document-id"
              maxLength={512}
              value={lookup}
              onChange={(event) => setLookup(event.target.value)}
              placeholder="Canonical document ID"
            />
            <button type="submit" disabled={resolving}>
              Locate
            </button>
          </div>
        </form>
      </header>
      <div className="geo-toolbar">
        <button type="button" aria-pressed={mode === "cells"} onClick={() => changeMode("cells")}>
          Clusters
        </button>
        <button type="button" aria-pressed={mode === "points"} onClick={() => changeMode("points")}>
          Individual points
        </button>
        <span role="status">
          {busy
            ? "Querying viewport…"
            : page
              ? `${(page.cells || page.points || []).length} ${mode === "cells" ? "cells" : "points"} · revision ${page.revision}`
              : ""}
        </span>
      </div>
      {error && (
        <p className="geo-error" role="alert">
          {error}
        </p>
      )}
      <div className="geo-layout">
        <div
          className="geo-map"
          ref={map}
          aria-label="Document map"
          role="region"
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.target.closest("button,a")) return;
            map.current.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, view };
          }}
          onPointerUp={(event) => {
            if (!drag.current) return;
            const prior = drag.current;
            drag.current = null;
            changeView(panView(prior.view, event.clientX - prior.x, event.clientY - prior.y));
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (event.target !== map.current) return;
            const moves = {
              ArrowLeft: [150, 0],
              ArrowRight: [-150, 0],
              ArrowUp: [0, 150],
              ArrowDown: [0, -150]
            };
            if (moves[event.key]) {
              event.preventDefault();
              changeView(panView(view, ...moves[event.key]));
            }
          }}
        >
          <div className="geo-tiles" aria-hidden="true">
            {tiles.map((tile) => (
              <img
                key={`${view.zoom}/${tile.key}`}
                src={tile.url}
                alt=""
                draggable={false}
                width={256}
                height={256}
                onError={() => setTileFailed(true)}
                style={{ left: tile.left, top: tile.top }}
              />
            ))}
          </div>
          {(!template || tileFailed) && (
            <p className="geo-basemap-status">
              {template
                ? "Local OSM tiles unavailable."
                : "Basemap disabled. Configure a local OSM tile source."}{" "}
              Document locations remain available.
            </p>
          )}
          <div className="geo-zoom">
            <button
              type="button"
              aria-label="Zoom in"
              disabled={view.zoom === 22}
              onClick={() => changeView({ ...view, zoom: view.zoom + 1 })}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              disabled={view.zoom === 1}
              onClick={() => changeView({ ...view, zoom: view.zoom - 1 })}
            >
              −
            </button>
            <span>z{view.zoom}</span>
          </div>
          {(page?.cells || []).map((cell) => {
            const [west, south, east, north] = cell.bbox;
            const [left, top] = screenPoint(
              (west + east) / 2,
              (south + north) / 2,
              view,
              size.width,
              size.height
            );
            return (
              <button
                type="button"
                className="geo-cluster"
                key={cell.id}
                style={{ left, top }}
                aria-label={`${cell.count} direct anchors in cell; zoom in`}
                onClick={() => zoomCell(cell)}
              >
                {cell.count.toLocaleString()}
              </button>
            );
          })}
          {(page?.points || []).map((point) => {
            const [left, top] = screenPoint(
              point.longitude,
              point.latitude,
              view,
              size.width,
              size.height
            );
            return (
              <button
                type="button"
                className="geo-point"
                key={point.id}
                style={{ left, top }}
                title={point.id}
                aria-label={`Select ${point.id}`}
                onClick={() => selectPoint(point)}
              />
            );
          })}
          {selected &&
            (() => {
              const [left, top] = screenPoint(
                selected.longitude,
                selected.latitude,
                view,
                size.width,
                size.height
              );
              return (
                <span className="geo-selected" style={{ left, top }} aria-label="Selected anchor" />
              );
            })()}
          <a
            className="geo-attribution"
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
          >
            © OpenStreetMap contributors
          </a>
        </div>
        <aside className="geo-details" aria-label="Map investigation">
          <h2>{selected ? "Document context" : "Explore this area"}</h2>
          {selectionError && <p role="alert">{selectionError}</p>}
          {!selected && (
            <p>
              Zoom into a cluster, then choose a point. Use a document ID to follow up to three
              explicit geographic links to a point.
            </p>
          )}
          {selected && (
            <>
              <p>
                <strong>
                  {selected.participationKind === "anchored"
                    ? "Anchored through explicit relations"
                    : "Direct geometry"}
                </strong>
              </p>
              <code>{selected.document || selected.id}</code>
              <p>
                {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)}
              </p>
              <p>
                Accuracy:{" "}
                {selected.accuracyMeters == null ? "unspecified" : `${selected.accuracyMeters} m`}
              </p>
              <Link to={`/documents/${encodeURIComponent(selected.document || selected.id)}`}>
                Open document
              </Link>
              {" · "}
              <Link
                to={`/graph?node=${encodeURIComponent(selected.document || selected.id)}&review=all`}
              >
                Open graph
              </Link>
              {!!selected.relationPath?.length && (
                <ol>
                  {selected.relationPath.map((link, index) => (
                    <li key={index}>
                      <code>{link.source}</code> → {link.predicate} → <code>{link.target}</code>
                      <Link to={`/documents/${encodeURIComponent(link.via)}`}>
                        {" "}
                        Inspect evidence
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
              <h3>Documents linked to this anchor</h3>
              <p>One hop per page; links preserve their canonical meaning.</p>
              <ul>
                {(relations?.relations || []).map((relation) => (
                  <li key={`${relation.via}/${relation.predicate}`}>
                    <button type="button" onClick={() => resolveDocument(relation.source)}>
                      {relation.source}
                    </button>
                    <span> — {relation.predicate} </span>
                    <Link to={`/documents/${encodeURIComponent(relation.via)}`}>Evidence</Link>
                  </li>
                ))}
              </ul>
              {relations && !relations.relations?.length && (
                <p>No visible incoming geographic links on this page.</p>
              )}
              {relations?.cursor && (
                <button type="button" onClick={nextRelations}>
                  Next relation page
                </button>
              )}
              {document && (
                <details>
                  <summary>Canonical document</summary>
                  <pre>{JSON.stringify(document, null, 2)}</pre>
                </details>
              )}
            </>
          )}
          <p className="geo-count-note">
            Cell counts cover whole cells and count direct point anchors. Related documents are
            loaded on selection. Points use exact viewport bounds. Display latitude is limited by
            Web Mercator.
          </p>
          {page && !page.complete && (
            <p>Partial page: {page.performance?.stopReason}. Continue to see more.</p>
          )}
          {page?.cursor && (
            <button type="button" onClick={nextPage} disabled={busy}>
              Next point page
            </button>
          )}
          {!!page?.points?.length && (
            <ul aria-label="Visible points">
              {page.points.map((point) => (
                <li key={point.id}>
                  <button type="button" onClick={() => selectPoint(point)}>
                    {point.id}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {page?.complete && !(page.cells || page.points || []).length && (
            <p>No direct point anchors in this view.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

export default function MapPage() {
  const { controlPlaneStatus } = useQuasar();
  const client = getControlPlane();
  return (
    <GeoWorkspace
      key={String(controlPlaneStatus?.connected)}
      revision={client?.getRevision() || 0}
    />
  );
}
