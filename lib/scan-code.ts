function decodeSafely(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Extract a sample code from a Code 128 value or a legacy QR-code URL. */
export function extractSampleCode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const lastPathPart = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return decodeSafely(lastPathPart).trim();
  } catch {
    const withoutQuery = trimmed.split(/[?#]/, 1)[0];
    const lastPart = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) || withoutQuery;
    return decodeSafely(lastPart).trim();
  }
}
