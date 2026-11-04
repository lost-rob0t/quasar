const settings = { serverUrl: "http://127.0.0.1:5191", serverToken: "synthetic-token", actors: [] };
export const useQuasar = () => ({
  settings,
  actors: [],
  selectedIds: [],
  persistSettings: async () => {},
  runActor: async () => {},
  setNotice: () => {}
});
