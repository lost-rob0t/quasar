export function startDocumentSource({ load, watch, onDocuments, onError = () => {} }) {
  let active = true;
  let request = 0;

  const refresh = async () => {
    const currentRequest = ++request;
    const documents = await load();
    if (active && currentRequest === request) onDocuments(documents);
    return documents;
  };

  const stopWatching = watch(() => {
    refresh().catch(onError);
  });

  return {
    initial: refresh(),
    refresh,
    stop() {
      active = false;
      stopWatching();
    }
  };
}
