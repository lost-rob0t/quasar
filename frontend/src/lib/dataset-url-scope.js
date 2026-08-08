export function normalizeDatasetScope(value) {
  const dataset = String(value || "").trim();
  if (!dataset || dataset === "complete-corpus") return null;
  return dataset;
}

function datasetSelectionFromSearch(search = "") {
  const params = new URLSearchParams(search);
  if (!params.has("dataset")) return { present: false, dataset: null };
  return { present: true, dataset: normalizeDatasetScope(params.get("dataset")) };
}

export function datasetSelectionFromUrls({ search = "", referrer = "", origin = "" } = {}) {
  const direct = datasetSelectionFromSearch(search);
  if (direct.present) return direct;
  if (!referrer) return direct;

  try {
    const referrerUrl = new URL(referrer, origin || undefined);
    if (origin && referrerUrl.origin !== origin) return direct;
    return datasetSelectionFromSearch(referrerUrl.search);
  } catch {
    return direct;
  }
}

export function datasetScopeFromUrls(urls = {}) {
  return datasetSelectionFromUrls(urls).dataset;
}

export function currentDatasetSelection() {
  return datasetSelectionFromUrls({
    search: globalThis.location?.search || "",
    referrer: globalThis.document?.referrer || "",
    origin: globalThis.location?.origin || ""
  });
}

export function currentDatasetScope() {
  return currentDatasetSelection().dataset;
}

export function resolveDatasetScope(requestedDataset, selection = currentDatasetSelection()) {
  if (selection.present) return selection.dataset;
  return normalizeDatasetScope(requestedDataset);
}
