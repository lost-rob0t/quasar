import { describe, expect, it } from "vitest";
import { filterDatasetOptions } from "./DatasetCombobox";

describe("dataset combobox filtering", () => {
  const options = ["reddit", "Reddit-Archive", "breach-compilation", "us-gov"];

  it("returns every option for an empty query", () => {
    expect(filterDatasetOptions(options, "")).toEqual(options);
    expect(filterDatasetOptions(options, "   ")).toEqual(options);
  });

  it("matches case-insensitively on substring", () => {
    expect(filterDatasetOptions(options, "reddit")).toEqual(["reddit", "Reddit-Archive"]);
    expect(filterDatasetOptions(options, "GOV")).toEqual(["us-gov"]);
  });

  it("returns nothing when no option matches", () => {
    expect(filterDatasetOptions(options, "mastodon")).toEqual([]);
  });
});
