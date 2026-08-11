const ROOT_BASE_PATH = "/";

export function normalizeBasePath(value: string | undefined): string {
  const basePath = value?.trim() || ROOT_BASE_PATH;

  if (
    !basePath.startsWith("/") ||
    basePath.startsWith("//") ||
    basePath.includes("\\") ||
    /[?#]/.test(basePath)
  ) {
    throw new Error(`VITE_BASE_PATH must be an absolute URL path, received "${basePath}"`);
  }

  const pathname = basePath.replace(/\/+$/, "");
  return pathname ? `${pathname}/` : ROOT_BASE_PATH;
}

export function routerBasename(basePath: string): string | undefined {
  const normalized = normalizeBasePath(basePath);
  return normalized === ROOT_BASE_PATH ? undefined : normalized.slice(0, -1);
}
