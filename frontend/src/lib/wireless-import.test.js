import { validateDocumentBatch } from "./document-batch";
import { fromPouchDocument } from "./canonical-document";
import { describe, it, expect, vi } from "vitest";
import { parseWirelessFile, restoreSourceBytes } from "./wireless-import";
import { collectImportDocuments, importFiles, IMPORT_LIMITS } from "./importer";
const header = "MAC,SSID,AuthMode,FirstSeen,Channel,RSSI,CurrentLatitude,CurrentLongitude,Type\n";
const row = '00:11:22:33:44:55,"lab, ""network""",[WPA2],2026-10-04 10:00:00,6,-42,0,0,WIFI';
const file = (name, text) => ({
  name,
  size: new TextEncoder().encode(text).length,
  text: async () => text
});
const parse = (text, format = "wigle-csv") =>
  parseWirelessFile(file("source.csv", text), format, "lab", IMPORT_LIMITS);
describe("wireless imports", () => {
  it("preserves raw WiGLE evidence and deduplicates identical observations", async () => {
    const r = await parse(`WigleWifi-1.6,appRelease=test\n${header}${row}\n${row}`);
    expect(r.documents).toHaveLength(1);
    expect(r.skippedDuplicates).toBe(1);
    expect(r.documents[0]).toMatchObject({
      dtype: "wireless-network",
      schemaVersion: "0.10.1",
      ssid: 'lab, "network"',
      security: "unknown",
      signalDbm: -42,
      raw: { CurrentLatitude: "0", FirstSeen: "2026-10-04 10:00:00" }
    });
  });
  it("uses deterministic IDs across renames and distinct IDs across datasets", async () => {
    const a = (await parse(header + row)).documents[0];
    const b = (
      await parseWirelessFile(file("rename.csv", header + row), "wigle-csv", "lab", IMPORT_LIMITS)
    ).documents[0];
    const c = (
      await parseWirelessFile(file("rename.csv", header + row), "wigle-csv", "other", IMPORT_LIMITS)
    ).documents[0];
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
  it("retains Kismet device facts without guessing a person or AP", async () => {
    const raw = {
      "kismet.device.base.key": "abc",
      "kismet.device.base.name": "sensor",
      zero: 0,
      flag: false,
      n: null
    };
    const r = await parse(JSON.stringify(raw), "kismet-json");
    expect(r.documents[0]).toMatchObject({ dtype: "document", raw });
  });
  it("rejects unsafe Kismet JSON numbers rather than silently rounding", async () => {
    await expect(
      parse('{"kismet.device.base.key":"abc","n":9007199254740993}', "kismet-json")
    ).rejects.toThrow(/exact JSON number/);
  });
  it("handles embedded CSV newlines and rejects broken records", async () => {
    expect(
      (await parse(header + row.replace('lab, ""network""', "lab\nnetwork"))).documents[0].ssid
    ).toBe("lab\nnetwork");
    await expect(parse(header + row + '"')).rejects.toThrow(/quoted|quote/);
    await expect(parse(header + row + ",extra")).rejects.toThrow(/column count/);
  });
  it("rejects invalid values atomically without calling persistence", async () => {
    const save = vi.fn();
    await expect(
      importFiles([file("bad.csv", header + row.replace("6,-42", "6,NaN"))], save, {
        format: "wigle-csv",
        dataset: "lab"
      })
    ).rejects.toThrow(/Atomic import rejected/);
    expect(save).not.toHaveBeenCalled();
  });
  it("enforces record, file and document bounds", async () => {
    await expect(
      parseWirelessFile(file("x", header + row), "wigle-csv", "lab", {
        ...IMPORT_LIMITS,
        maxRecordBytes: 10
      })
    ).rejects.toThrow(/record limit/);
    await expect(
      parseWirelessFile(file("x", header + row), "wigle-csv", "lab", {
        ...IMPORT_LIMITS,
        maxFileBytes: 1
      })
    ).rejects.toThrow(/limit/);
    await expect(
      parseWirelessFile(file("x", header + row), "wigle-csv", "lab", {
        ...IMPORT_LIMITS,
        maxDocuments: 0
      })
    ).rejects.toThrow(/document limit/);
  });
  it("connects format selection to the existing import pipeline", async () => {
    const r = await collectImportDocuments([file("x.csv", header + row)], {
      format: "wigle-csv",
      dataset: "lab"
    });
    expect(r.documents[0].dataset).toBe("lab");
    expect(r.errors).toEqual([]);
  });
  it("deduplicates repeated source records across files and reports them", async () => {
    const save = vi.fn(async () => ({ saved: [] }));
    const report = await importFiles(
      [file("one.csv", header + row), file("two.csv", header + row)],
      save,
      { format: "wigle-csv", dataset: "lab" }
    );
    expect(save.mock.calls[0][0]).toHaveLength(3);
    expect(report.skippedDuplicateCount).toBe(1);
  });
  it("rejects duplicate source filenames instead of silently overwriting parsed input", async () => {
    await expect(
      collectImportDocuments([file("same.csv", header + row), file("same.csv", header + row)], {
        format: "wigle-csv",
        dataset: "lab"
      })
    ).rejects.toThrow(/Duplicate input filename/);
  });
  it("rejects negative-zero source values instead of hashing a lossy record", async () => {
    for (const token of ["-0", "-0.0", "-0e3"]) {
      await expect(
        parse(`{"kismet.device.base.key":"abc","raw":{"n":${token}}}`, "kismet-json")
      ).rejects.toThrow(/negative zero/);
    }
  });
  it("retains exact source bytes and rejects corrupted/reordered/missing custody chunks", async () => {
    const text =
      "\uFEFFWigleWifi-1.6,appRelease=test\r\n" + header.replaceAll("\n", "\r\n") + row + "\r\n";
    const r = await parse(text);
    expect(
      new TextDecoder("utf8", { ignoreBOM: true }).decode(
        await restoreSourceBytes(r.sourceArtifacts)
      )
    ).toBe(text);
    expect(r.documents[0].provenance.sourceByteHash).toBe(r.sourceArtifacts[0].bytesHash);
    expect(r.documents[0].sources[0].id).toBe(r.sourceArtifacts[0].id);
    expect(r.documents[0].normalizedHash).toBeDefined();
    expect(r.documents[0].contentHash).toBeUndefined();
    const corrupt = structuredClone(r.sourceArtifacts);
    corrupt[1].rawContent = "YQ==";
    await expect(restoreSourceBytes(corrupt)).rejects.toThrow(/mismatch/);
    await expect(restoreSourceBytes(r.sourceArtifacts.slice(0, 1))).rejects.toThrow(/manifest/);
    const order = structuredClone(r.sourceArtifacts);
    order[1].extensions.quasarSourceChunk.index = 4;
    await expect(restoreSourceBytes(order)).rejects.toThrow(/order/);
  });
  it("recovers multi-chunk original bytes within bounds and detects swaps", async () => {
    const text =
      JSON.stringify({ "kismet.device.base.key": "synthetic", note: "x".repeat(140000) }) + "\n";
    const r = await parse(text, "kismet-json");
    expect(r.sourceArtifacts).toHaveLength(4);
    expect(new TextDecoder().decode(await restoreSourceBytes(r.sourceArtifacts))).toBe(text);
    const swapped = [...r.sourceArtifacts];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    await expect(restoreSourceBytes(swapped)).rejects.toThrow(/order/);
  });
  it("preserves custody artifacts through actual application batch validation and projection", async () => {
    const collected = await collectImportDocuments([file("source.csv", header + row)], {
      format: "wigle-csv",
      dataset: "lab"
    });
    const batch = validateDocumentBatch(collected.documents);
    expect(batch.errors).toEqual([]);
    expect(batch.validated.map((entry) => fromPouchDocument(entry.document))).toEqual(
      collected.documents
    );
  });
});
