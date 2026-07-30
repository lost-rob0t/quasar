export function openImportedGraph({ importedIds, select, navigate }) {
  const ids = [...new Set((importedIds || []).filter(Boolean))];
  if (!ids.length) return false;
  select(ids);
  navigate("/graph", {
    state: {
      importedIds: ids,
      revealUnreviewed: true,
      source: "local-import"
    }
  });
  return true;
}
