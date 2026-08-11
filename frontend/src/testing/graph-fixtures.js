export const FIXTURE_SCHEMA_VERSION = "1.0.0";
export const FIXTURE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseDocument(id, dtype, dataset, data, extra = {}) {
  return {
    _id: id,
    dataset,
    dtype,
    schema_version: "0.9.0",
    version: 1,
    date_added: FIXTURE_TIMESTAMP,
    date_updated: FIXTURE_TIMESTAMP,
    title: String(data.full_name || data.name || id),
    sources: [],
    evidence: [],
    verification: { verified: true, status: "verified" },
    data,
    ...extra
  };
}

function relation(id, dataset, subject, predicate, object) {
  return baseDocument(id, "relation", dataset, {
    subject,
    predicate,
    object,
    source: subject,
    target: object,
    directed: true,
    confidence: 1,
    active: true
  });
}

export function blankGraphFixture() {
  return {
    fixtureVersion: FIXTURE_SCHEMA_VERSION,
    documents: [],
    workspace: {
      graphs: [
        {
          id: "all-documents",
          name: "All documents",
          documentIds: null,
          positions: {},
          viewport: null,
          layout: "cose",
          selectedIds: []
        }
      ],
      activeGraphId: "all-documents"
    }
  };
}

export function smallTypedGraphFixture() {
  const person = baseDocument("starintel:person:ada", "person", "people", {
    full_name: "Ada Lovelace"
  });
  const organization = baseDocument("starintel:org:analytical-society", "org", "organizations", {
    name: "Analytical Society"
  });
  const event = baseDocument("starintel:event:lecture", "event", "events", {
    name: "Public lecture"
  });
  const relations = [
    relation("starintel:relation:ada-member", "people", person._id, "member-of", organization._id),
    relation("starintel:relation:ada-lecture", "events", person._id, "participated-in", event._id)
  ];
  const documents = [person, organization, event, ...relations];

  return {
    fixtureVersion: FIXTURE_SCHEMA_VERSION,
    documents,
    workspace: {
      graphs: [
        {
          id: "cross-dataset-investigation",
          name: "Cross-dataset investigation",
          documentIds: documents.map((document) => document._id),
          positions: {
            [person._id]: { x: 0, y: 0 },
            [organization._id]: { x: 240, y: -100 },
            [event._id]: { x: 240, y: 100 }
          },
          viewport: { zoom: 1, pan: { x: 0, y: 0 } },
          layout: "preset",
          selectedIds: [person._id]
        }
      ],
      activeGraphId: "cross-dataset-investigation"
    }
  };
}

export function unknownTypeGraphFixture() {
  return {
    fixtureVersion: FIXTURE_SCHEMA_VERSION,
    documents: [
      baseDocument(
        "starintel:future:one",
        "future-entity",
        "future-data",
        { name: "Forward-compatible record", extension_value: { nested: true } },
        { fixture_extension: "preserve-me" }
      )
    ]
  };
}

export function highDegreeGraphFixture(leafCount = 32) {
  const hub = baseDocument("starintel:org:hub", "org", "scale", { name: "Hub" });
  const leaves = Array.from({ length: leafCount }, (_, index) =>
    baseDocument(`starintel:org:leaf-${String(index).padStart(4, "0")}`, "org", "scale", {
      name: `Leaf ${index}`
    })
  );
  const relations = leaves.map((leaf, index) =>
    relation(
      `starintel:relation:hub-leaf-${String(index).padStart(4, "0")}`,
      "scale",
      hub._id,
      "connected-to",
      leaf._id
    )
  );
  return {
    fixtureVersion: FIXTURE_SCHEMA_VERSION,
    documents: [hub, ...leaves, ...relations],
    expected: { nodes: leafCount + 1, edges: leafCount, hubDegree: leafCount }
  };
}

export function invalidDocumentFixtures() {
  return [
    {
      name: "unknown-dtype",
      document: {
        _id: "invalid",
        dtype: "not-a-real-dtype"
      }
    },
    {
      name: "missing-relation-object",
      document: baseDocument("starintel:relation:missing-object", "relation", "invalid", {
        subject: "starintel:org:a",
        predicate: "connected-to",
        source: "starintel:org:a",
        directed: true
      })
    }
  ];
}

export function legacyWorkspaceFixture() {
  return {
    positions: { "starintel:person:ada": { x: 20, y: 40 } },
    viewport: { zoom: 1.25, pan: { x: 10, y: -10 } },
    layout: "grid",
    selectedIds: ["starintel:person:ada"]
  };
}

export function operationFixtures() {
  const document = smallTypedGraphFixture().documents[0];
  const save = { type: "save-document", document };
  const remove = { type: "remove-document", id: document._id };
  return {
    command: save,
    batch: { type: "batch", label: "Fixture batch", operations: [save, remove] },
    import: { replace: false, atomic: true, documents: smallTypedGraphFixture().documents },
    export: {
      format: "jsonl",
      documentIds: smallTypedGraphFixture().documents.map((item) => item._id)
    },
    revisionTrace: [
      { revision: "1-fixture", operation: save },
      { revision: "2-fixture", operation: remove }
    ]
  };
}

export function performanceGraphFixture(nodeCount) {
  if (!Number.isInteger(nodeCount) || nodeCount < 0) {
    throw new TypeError("nodeCount must be a non-negative integer");
  }
  return {
    fixtureVersion: FIXTURE_SCHEMA_VERSION,
    documents: Array.from({ length: nodeCount }, (_, index) =>
      baseDocument(
        `starintel:org:performance-${String(index).padStart(5, "0")}`,
        "org",
        "performance",
        { name: `Performance node ${index}`, ordinal: index }
      )
    ),
    expected: { nodes: nodeCount, edges: 0 }
  };
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])])
  );
}

export function stableSerialize(value, spacing = 0) {
  return JSON.stringify(sorted(value), null, spacing);
}

export function fixtureFiles() {
  const documents = smallTypedGraphFixture().documents;
  const first = documents[0];
  const csvData = stableSerialize(first.data).replaceAll('"', '""');
  return {
    json: stableSerialize({ fixtureVersion: FIXTURE_SCHEMA_VERSION, documents }, 2),
    jsonl: `${documents.map((document) => stableSerialize(document)).join("\n")}\n`,
    csv: `_id,dataset,dtype,title,data\n${first._id},${first.dataset},${first.dtype},${first.title},"${csvData}"\n`,
    invalidJson: '{"documents": [}',
    invalidJsonl: `${stableSerialize(first)}\n{not-json}\n`,
    invalidCsv: `_id,dataset,dtype,data\ninvalid,invalid,org,"{not-json}"\n`
  };
}

export const fixtureManifest = Object.freeze({
  fixtureVersion: FIXTURE_SCHEMA_VERSION,
  documentSchemaVersion: "0.9.0",
  supportedSerializedFormats: ["json", "jsonl", "ndjson", "csv"],
  performanceNodeCounts: [100, 10000],
  expectedRoundTrip: {
    json: "all document and extension fields",
    jsonl: "all document and extension fields",
    csv: "identity, dataset, type, title, and data fields"
  }
});

export function cloneFixture(value) {
  return clone(value);
}
