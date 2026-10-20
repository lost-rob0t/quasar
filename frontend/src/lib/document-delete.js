export function connectedDocumentIds(documents, ids) {
  const selected = new Set((ids || []).map(String).filter(Boolean));
  let changed = true;

  while (changed) {
    changed = false;
    for (const document of documents || []) {
      if (document?.dtype !== "relation" || selected.has(document._id)) continue;
      const subject =
        typeof document.data?.subject === "object"
          ? document.data.subject?.id
          : document.data?.subject;
      const object =
        typeof document.data?.object === "object"
          ? document.data.object?.id
          : document.data?.object;
      if (!selected.has(subject) && !selected.has(object)) continue;
      selected.add(document._id);
      changed = true;
    }
  }

  return [...selected];
}
