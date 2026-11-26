export function safeMediaPath(value) {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/\\/g, "/");
  if (!path || path.length > 240 || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some(part =>
    !part ||
    part === "." ||
    part === ".." ||
    part.startsWith(".") ||
    !/^[\p{L}\p{N} _().-]+$/u.test(part)
  )) return null;
  const extension = parts[parts.length - 1].split(".").pop().toLowerCase();
  if (!["mp3", "m4a", "aac", "ogg", "opus", "flac", "wav"].includes(extension)) return null;
  return parts.join("/");
}

export function decodeMediaFile(encoded, maxBytes) {
  if (typeof encoded !== "string" || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  const maxEncodedBytes = Math.ceil(maxBytes * 4 / 3);
  if (!encoded.length || encoded.length > maxEncodedBytes || encoded.length % 4 !== 0) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maxBytes || bytes.toString("base64") !== encoded) return null;
  return bytes;
}
