import { describe, expect, it } from "vitest";
import { documentsFromQueuePayload } from "./rabbitmq-ingest";

describe("RabbitMQ queue payloads", () => {
  it("accepts single documents and document batches", () => {
    const document = { _id: "one", dtype: "entity", data: {} };
    expect(documentsFromQueuePayload(JSON.stringify(document))).toEqual([document]);
    expect(documentsFromQueuePayload({ document })).toEqual([document]);
    expect(documentsFromQueuePayload({ documents: [document] })).toEqual([document]);
  });

  it("rejects non-document delivery shapes", () => {
    expect(() => documentsFromQueuePayload("null")).toThrow("document or document batch");
  });
});
