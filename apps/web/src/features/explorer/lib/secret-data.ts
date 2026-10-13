import type { KObj } from "@/lib/k8s";

export interface DataEntry {
  key: string;
  /** Decoded text, or null when the bytes are not valid UTF-8. */
  text: string | null;
  bytes: number;
  /** Secret `data` and ConfigMap `binaryData` arrive base64-encoded. */
  encoded: boolean;
}

/** Decodes base64 to a string, returning null for bytes that are not text. */
const decodeBase64 = (value: string): { text: string | null; bytes: number } => {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    // fatal:true rejects lone surrogates and invalid sequences, which is how a
    // TLS key or a gzipped blob is told apart from text worth showing.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return { text, bytes: bytes.length };
  } catch {
    // Either not valid base64, or valid base64 that is not UTF-8 text. Only the
    // first case leaves the length unknown, so fall back to the raw length.
    let bytes: number;
    try {
      bytes = atob(value).length;
    } catch {
      bytes = value.length;
    }

    return { text: null, bytes };
  }
};

/**
 * Flattens a Secret or ConfigMap into displayable entries.
 *
 * Secret `data` and ConfigMap `binaryData` are base64; ConfigMap `data` and
 * Secret `stringData` are already plain. Secrets never return `stringData` from
 * the API server, but a locally edited object can carry it, so it is handled.
 */
export const dataEntries = (obj: KObj): DataEntry[] => {
  const out: DataEntry[] = [];
  const encodedSource = (obj.kind === "Secret" ? obj.data : obj.binaryData) as Record<string, string> | undefined;
  const plainSource = (obj.kind === "Secret" ? obj.stringData : obj.data) as Record<string, string> | undefined;

  for (const [key, value] of Object.entries(encodedSource ?? {})) {
    const { text, bytes } = decodeBase64(String(value));
    out.push({ key, text, bytes, encoded: true });
  }
  for (const [key, value] of Object.entries(plainSource ?? {})) {
    const text = String(value);
    out.push({ key, text, bytes: new TextEncoder().encode(text).length, encoded: false });
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
};

export const hasData = (obj: KObj): boolean => obj.kind === "Secret" || obj.kind === "ConfigMap";
