import { describe, expect, it } from "vitest";
import { schema } from "starintel_doc";
import {
  dataFieldsForDtype,
  dataSchemaForDtype,
  dtypeLabel,
  effectiveFieldSchema,
  emptySchemaValue,
  essentialDataFieldsForDtype,
  generateEmptyDocument,
  isNullableSchema
} from "./schema-form";

function expectEmptyValue(value, fieldSchema) {
  if (Object.hasOwn(fieldSchema, "const")) {
    expect(value).toEqual(fieldSchema.const);
    return;
  }
  if (isNullableSchema(fieldSchema)) {
    expect(value).toBeNull();
    return;
  }
  const resolved = effectiveFieldSchema(fieldSchema);
  if (resolved.type === "string") expect(value).toBe("");
  else if (resolved.type === "array") expect(value).toEqual([]);
  else if (resolved.type === "boolean") expect(value).toBe(false);
  else if (resolved.type === "integer" || resolved.type === "number") expect(value).toBe(0);
  else if (resolved.type === "object") {
    expect(value).toEqual(expect.any(Object));
    for (const [name, child] of Object.entries(resolved.properties || {})) {
      expect(value).toHaveProperty(name);
      expectEmptyValue(value[name], child);
    }
  } else expect(value).toBeNull();
}

describe("schema-driven document fields", () => {
  it("uses person data properties from the active StarIntel schema", () => {
    const fields = dataFieldsForDtype("person");
    expect(fields).toEqual(
      expect.arrayContaining([
        "fname",
        "mname",
        "lname",
        "full_name",
        "dob",
        "nationalities",
        "occupations"
      ])
    );
    expect(dataSchemaForDtype("person").additionalProperties).toBe(false);
  });

  it("switches to organization fields without leaking person fields", () => {
    const fields = dataFieldsForDtype("org");
    expect(fields).toEqual(
      expect.arrayContaining([
        "name",
        "legal_name",
        "org_type",
        "industry",
        "headquarters",
        "registration_number",
        "website"
      ])
    );
    expect(fields).not.toContain("fname");
    expect(fields).not.toContain("mname");
    expect(fields).not.toContain("lname");
  });

  it("keeps compact fields short and schema-backed", () => {
    for (const dtype of ["person", "org", "event", "location", "target", "relation"]) {
      const schemaFields = new Set(dataFieldsForDtype(dtype));
      const essentialFields = essentialDataFieldsForDtype(dtype);
      expect(essentialFields.length).toBeLessThanOrEqual(6);
      expect(essentialFields.every((field) => schemaFields.has(field))).toBe(true);
    }
    expect(essentialDataFieldsForDtype("person")).toEqual(
      expect.arrayContaining(["fname", "mname", "lname"])
    );
    expect(essentialDataFieldsForDtype("org")).toEqual(
      expect.arrayContaining(["name", "org_type"])
    );
    expect(essentialDataFieldsForDtype("target")[0]).toBe("target");
  });

  it("uses object names instead of raw dtype jargon", () => {
    expect(dtypeLabel("person")).toBe("Person");
    expect(dtypeLabel("org")).toBe("Organization");
    expect(dtypeLabel("target")).toBe("Target");
  });
});

describe("empty StarIntel document generation", () => {
  it.each(["person", "org", "relation", "target"])(
    "generates every active %s field with type-correct empty values",
    (dtype) => {
      const { document, warnings } = generateEmptyDocument(dtype);
      const variant = schema.allOf.find(
        (candidate) => candidate.if?.properties?.dtype?.const === dtype
      );
      const dataSchema = variant.then.properties.data;

      expect(document.dtype).toBe(dtype);
      expect(Object.keys(document.data).sort()).toEqual(dataFieldsForDtype(dtype).sort());
      for (const [name, fieldSchema] of Object.entries(dataSchema.properties || {})) {
        expect(document.data).toHaveProperty(name);
        expectEmptyValue(document.data[name], fieldSchema);
      }
      expect(document._id).toBe("");
      expect(document.sources).toEqual([]);
      expect(document.date_added).toBe("");
      expect(document.date_updated).toBe("");
      expect(warnings).toEqual([]);
    }
  );

  it("generates nested objects recursively and keeps constants", () => {
    const activeSchema = {
      type: "object",
      properties: {
        _id: { type: "string" },
        dtype: { type: "string" },
        fixed: { const: "locked" },
        data: { type: "object" }
      },
      allOf: [
        {
          if: { properties: { dtype: { const: "person" } } },
          then: {
            properties: {
              dtype: { const: "person" },
              data: {
                type: "object",
                properties: {
                  identity: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      active: { type: "boolean" },
                      aliases: { type: "array", items: { type: "string" } }
                    }
                  }
                }
              }
            }
          }
        }
      ]
    };

    const { document } = generateEmptyDocument("person", { activeSchema });
    expect(document).toEqual({
      _id: "",
      dtype: "person",
      fixed: "locked",
      data: { identity: { name: "", active: false, aliases: [] } }
    });
  });

  it("uses null and emits a warning for unsupported schema types", () => {
    const warnings = [];
    expect(emptySchemaValue({ type: "funky" }, { warnings, path: "data.odd" })).toBeNull();
    expect(warnings).toEqual(["Unsupported schema type at data.odd; generated null."]);
  });

  it("does not fabricate IDs, dates, sources, names, or references", () => {
    const { document } = generateEmptyDocument("person");
    expect(document._id).toBe("");
    expect(document.title || "").toBe("");
    expect(document.sources).toEqual([]);
    expect(document.date_added).toBe("");
    expect(document.date_updated).toBe("");
    expect(JSON.stringify(document)).not.toContain("randomUUID");
  });
});
