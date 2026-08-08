export function redactDiagnostic(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|secret|password|api[_-]?key)=)[^\s&#]+/gi, "$1[redacted]")
    .replace(
      /\b(authorization|password|secret|token|api[_-]?key)(\s*[=:]\s*)[^\s,;}]+/gi,
      "$1$2[redacted]"
    );
}
