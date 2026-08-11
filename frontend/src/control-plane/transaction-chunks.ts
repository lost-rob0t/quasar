export const DEFAULT_TRANSACTION_BYTE_LIMIT = 512 * 1024;

const ENVELOPE_RESERVE_BYTES = 2048;
const encoder = new TextEncoder();

function encodedBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

export function chunkTransactionOperations(
  operations: unknown[],
  byteLimit = DEFAULT_TRANSACTION_BYTE_LIMIT
): unknown[][] {
  if (byteLimit <= ENVELOPE_RESERVE_BYTES)
    throw new RangeError("Transaction byte limit is too low");

  const chunks: unknown[][] = [];
  let chunk: unknown[] = [];
  let chunkBytes = ENVELOPE_RESERVE_BYTES;

  for (const operation of operations) {
    const operationBytes = encodedBytes(operation) + (chunk.length ? 1 : 0);
    if (operationBytes + ENVELOPE_RESERVE_BYTES > byteLimit) {
      throw new RangeError("A document exceeds the control-plane transaction size limit");
    }
    if (chunk.length && chunkBytes + operationBytes > byteLimit) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = ENVELOPE_RESERVE_BYTES;
    }
    chunk.push(operation);
    chunkBytes += operationBytes;
  }

  if (chunk.length) chunks.push(chunk);
  return chunks;
}
