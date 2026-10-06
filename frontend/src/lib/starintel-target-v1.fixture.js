// Executable request fixture, not a live StarIntel server.
// Source: starintel-server ce14c77ccd2f51f543410fdeef3d78fb9978b769
// source/frontends/http-target-v1.lisp, target-v1-document-from-request and helpers.
// Mirrors only the fields exercised here; server scheduling limits and auth stay server-owned.
export function targetV1FixtureResponse(body) {
  for (const [field, code] of [
    ["actor", "invalid_target_actor"],
    ["target", "invalid_target_subject"],
    ["dataset", "invalid_target_dataset"]
  ]) {
    if (typeof body[field] !== "string" || !body[field].trim()) {
      return {
        status: 422,
        body: { code, message: `${field} must be a non-empty string` }
      };
    }
  }
  if (typeof body.idempotency_key !== "string" || !body.idempotency_key.trim()) {
    return {
      status: 400,
      body: {
        code: "idempotency_key_required",
        message: "idempotency_key is required"
      }
    };
  }
  if (new TextEncoder().encode(body.idempotency_key).length > 256) {
    return {
      status: 422,
      body: {
        code: "idempotency_key_too_large",
        message: "idempotency_key exceeds the configured limit"
      }
    };
  }
  if (!Number.isInteger(body.delay) || body.delay < 1) {
    return {
      status: 422,
      body: {
        code: "invalid_target_delay",
        message: "delay must be a positive integer"
      }
    };
  }
  if (typeof body.recurring !== "boolean") {
    return {
      status: 422,
      body: {
        code: "invalid_target_recurring",
        message: "recurring must be a boolean"
      }
    };
  }
  if (!Array.isArray(body.options)) {
    return {
      status: 422,
      body: {
        code: "invalid_target_options",
        message: "options must be a JSON array"
      }
    };
  }
  return {
    status: 201,
    body: {
      status: "accepted",
      target_id: "target:fixture",
      request_id: "target-request:fixture",
      correlation_id: "fixture"
    }
  };
}
