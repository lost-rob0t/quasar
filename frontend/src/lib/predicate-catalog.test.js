import { describe, expect, it } from "vitest";
import {
  STAR_CL_PREDICATE_IDS,
  STAR_CL_PREDICATES,
  buildPredicateCatalog,
  normalizeCustomPredicateId,
  searchPredicates,
  similarPredicates,
  validateCustomPredicateId
} from "./predicate-catalog";

const person = { _id: "starintel:person:a", dtype: "person", data: { full_name: "A" } };
const org = { _id: "starintel:org:b", dtype: "org", data: { name: "B" } };
const relation = {
  _id: "starintel:relation:a-b",
  dtype: "relation",
  data: { subject: person._id, predicate: "employed-by", object: org._id }
};

describe("predicate catalog", () => {
  it("loads the real star-cl relation allowlist", () => {
    expect(STAR_CL_PREDICATE_IDS).toContain("employed-by");
    expect(STAR_CL_PREDICATE_IDS).toContain("member-of");
    expect(STAR_CL_PREDICATE_IDS).toContain("reports-to");
    expect(STAR_CL_PREDICATE_IDS.length).toBeGreaterThan(80);
    expect(STAR_CL_PREDICATES.every((predicate) => predicate.source === "star-cl")).toBe(true);
  });

  it("searches star-cl IDs through snake_case aliases", () => {
    const results = searchPredicates(STAR_CL_PREDICATES, { query: "employed_by" });
    expect(results[0].id).toBe("employed-by");
    expect(results[0].aliases).toContain("employed_by");
  });

  it("loads predicates already used in the active dataset", () => {
    const catalog = buildPredicateCatalog({ documents: [person, org, relation] });
    const employed = catalog.find((predicate) => predicate.id === "employed-by");
    expect(employed).toBeTruthy();
    expect(employed.usageCount).toBe(1);
  });

  it("prioritizes recent and dataset predicates", () => {
    const catalog = [
      {
        id: "alpha",
        label: "Alpha",
        aliases: [],
        sourceTypes: ["*"],
        targetTypes: ["*"],
        common: true
      },
      {
        id: "beta",
        label: "Beta",
        aliases: [],
        sourceTypes: ["*"],
        targetTypes: ["*"],
        common: false
      }
    ];
    const results = searchPredicates(catalog, { recentIds: ["beta"], datasetIds: ["beta"] });
    expect(results[0].id).toBe("beta");
  });

  it("filters source and target compatibility", () => {
    const catalog = [
      {
        id: "employed_by",
        label: "Employed by",
        aliases: [],
        sourceTypes: ["person"],
        targetTypes: ["org"]
      },
      {
        id: "located_in",
        label: "Located in",
        aliases: [],
        sourceTypes: ["org"],
        targetTypes: ["location"]
      }
    ];
    expect(
      searchPredicates(catalog, { sourceType: "person", targetType: "org" }).map((item) => item.id)
    ).toEqual(["employed_by"]);
  });

  it("normalizes and validates custom predicates", () => {
    expect(normalizeCustomPredicateId("  Employed By  ")).toBe("employed_by");
    expect(validateCustomPredicateId("employed_by")).toEqual({
      valid: true,
      id: "employed_by",
      message: ""
    });
    expect(validateCustomPredicateId("9bad predicate").valid).toBe(false);
  });

  it("warns about near-duplicate predicate names", () => {
    const similar = similarPredicates("employd_by", [{ id: "employed_by" }, { id: "located_in" }]);
    expect(similar[0].id).toBe("employed_by");
  });
});
