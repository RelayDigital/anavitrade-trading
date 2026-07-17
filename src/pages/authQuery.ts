export function stripSensitiveQueryParams(url: string, names: readonly string[]) {
  const parsed = new URL(url, "https://auth.invalid");
  const valueByName: Record<string, string | null> = {};
  for (const name of names) {
    valueByName[name] = parsed.searchParams.get(name);
    parsed.searchParams.delete(name);
  }
  return {
    valueByName,
    sanitizedPath: `${parsed.pathname}${parsed.search}${parsed.hash}`,
  };
}

export function consumeSensitiveQueryParams(names: readonly string[]) {
  if (typeof window === "undefined") return {} as Record<string, string | null>;
  const result = stripSensitiveQueryParams(window.location.href, names);
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (result.sanitizedPath !== currentPath) {
    window.history.replaceState(window.history.state, "", result.sanitizedPath);
  }
  return result.valueByName;
}

