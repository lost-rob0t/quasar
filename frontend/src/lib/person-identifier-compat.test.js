import { expect, it } from "vitest";
import { createDocument } from "starintel_doc/legacy";
import { toCanonicalDocument, toLegacyUiDocument } from "./canonical-document";
it("preserves empty person identifier defaults and refuses unplanned identifier bundles", () => {
  const person = createDocument("person", {
    dataset: "test",
    data: { fname: "Test", lname: "Person", external_ids: [] }
  });
  const canonical = toCanonicalDocument(person, { allowLegacy090: true });
  expect(canonical).not.toHaveProperty("externalIds");
  expect(toLegacyUiDocument(canonical).data.external_ids).toEqual([]);
  expect(() =>
    toCanonicalDocument(
      {
        ...person,
        data: { ...person.data, external_ids: [{ scheme: "username", value: "test" }] }
      },
      { allowLegacy090: true }
    )
  ).toThrow("atomic bundle application is unavailable");
});
