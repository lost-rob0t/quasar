import { describe, expect, it } from "vitest";
import {
  datasetScopeFromUrls,
  datasetSelectionFromUrls,
  resolveDatasetScope
} from "./dataset-url-scope";

describe("URL dataset scope", () => {
  it("uses the dataset parameter from Quasar's own URL", () => {
    expect(
      datasetScopeFromUrls({
        search: "?host=auto-dig&dataset=hunter-biden",
        referrer: "https://starintel.test/quasar/?dataset=wef",
        origin: "https://starintel.test"
      })
    ).toBe("hunter-biden");
  });

  it("uses the same-origin embedding page when the child URL has no dataset", () => {
    expect(
      datasetScopeFromUrls({
        search: "?host=auto-dig",
        referrer: "https://starintel.test/quasar/?dataset=wef",
        origin: "https://starintel.test"
      })
    ).toBe("wef");
  });

  it("does not trust a cross-origin referrer", () => {
    expect(
      datasetSelectionFromUrls({
        search: "?host=auto-dig",
        referrer: "https://example.test/quasar/?dataset=wef",
        origin: "https://starintel.test"
      })
    ).toEqual({ present: false, dataset: null });
  });

  it("keeps complete-corpus as an explicit all-datasets view", () => {
    const selection = datasetSelectionFromUrls({
      search: "?dataset=complete-corpus",
      referrer: "https://starintel.test/quasar/?dataset=wef",
      origin: "https://starintel.test"
    });

    expect(selection).toEqual({ present: true, dataset: null });
    expect(resolveDatasetScope("palantir", selection)).toBeNull();
  });

  it("gives URL scope precedence over the dataset dropdown", () => {
    expect(resolveDatasetScope("palantir", { present: true, dataset: "wef" })).toBe("wef");
    expect(resolveDatasetScope("palantir", { present: false, dataset: null })).toBe("palantir");
  });
});
