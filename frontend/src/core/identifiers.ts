const STABLE_IDENTIFIER_PATTERN = /^(?=.{1,256}$)[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export class InvalidIdentifierError extends TypeError {
  readonly value: unknown;

  constructor(value: unknown, label = "identifier") {
    super(
      `${label} must be 1-256 characters and contain only letters, numbers, '.', '_', ':', '/', or '-'`
    );
    this.name = "InvalidIdentifierError";
    this.value = value;
  }
}

export function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && STABLE_IDENTIFIER_PATTERN.test(value);
}

export function assertStableIdentifier(
  value: unknown,
  label = "identifier"
): asserts value is string {
  if (!isStableIdentifier(value)) throw new InvalidIdentifierError(value, label);
}
