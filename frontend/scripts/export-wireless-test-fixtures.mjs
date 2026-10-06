import { createServer } from "vite";
import { readFile, writeFile } from "node:fs/promises";
const output = process.argv[2];
if (!output) throw new Error("Supply output JSON path for native integration test");
const server = await createServer({ server: { middlewareMode: true } });
try {
  const { parseWirelessFile, restoreSourceBytes } = await server.ssrLoadModule(
    "/src/lib/wireless-import.js"
  );
  const documents = [];
  for (const [name, format] of [
    ["wigle.csv", "wigle-csv"],
    ["kismet.jsonl", "kismet-json"]
  ]) {
    const text = await readFile(
      new URL(`../tests/fixtures/wireless/${name}`, import.meta.url),
      "utf8"
    );
    const result = await parseWirelessFile(
      { name, size: Buffer.byteLength(text), text: async () => text },
      format,
      "synthetic-import",
      { maxFileBytes: 16777216, maxDocuments: 10000, maxRecordBytes: 1048576, maxErrors: 100 }
    );
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    documents.push(...result.documents, ...result.sourceArtifacts);
  }
  if (process.argv[3]) {
    const readback = JSON.parse(await readFile(process.argv[3], "utf8"));
    for (const source of readback.filter(
      (doc) => doc.dtype === "file" && doc.extensions?.quasarSource
    )) {
      const artifacts = [
        source,
        ...source.extensions.quasarSource.chunkIds.map((id) =>
          readback.find((doc) => doc.id === id)
        )
      ];
      const restored = await restoreSourceBytes(artifacts);
      const original = await readFile(
        new URL(`../tests/fixtures/wireless/${source.filename}`, import.meta.url)
      );
      if (!Buffer.from(restored).equals(original))
        throw new Error("Original source bytes changed after native process restart");
    }
    console.log("Original source bytes verified byte-for-byte after native Tek9 process restart");
  }
  await writeFile(output, JSON.stringify(documents));
  console.log(`Exported ${documents.length} production-adapter fixtures to ${output}`);
} finally {
  await server.close();
}
