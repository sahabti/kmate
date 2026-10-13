import { describe, expect, it } from "vitest";
import { dataEntries } from "@/features/explorer/lib/secret-data";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("dataEntries", () => {
  it("should decode a Secret's base64 data", () => {
    const entries = dataEntries({ kind: "Secret", data: { password: b64("hunter2") } });
    expect(entries).toEqual([{ key: "password", text: "hunter2", bytes: 7, encoded: true }]);
  });

  it("should report binary values as undisplayable rather than mojibake", () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x01]).toString("base64");
    const [entry] = dataEntries({ kind: "Secret", data: { "tls.key": binary } });
    expect(entry.text).toBeNull();
    expect(entry.bytes).toBe(4);
  });

  it("should leave a ConfigMap's data alone and decode only binaryData", () => {
    const entries = dataEntries({
      kind: "ConfigMap",
      data: { "app.conf": "listen = 8080" },
      binaryData: { "logo.bin": b64("png") },
    });
    expect(entries.map((e) => [e.key, e.text, e.encoded])).toEqual([
      ["app.conf", "listen = 8080", false],
      ["logo.bin", "png", true],
    ]);
  });

  it("should handle a Secret carrying stringData from a local edit", () => {
    const entries = dataEntries({ kind: "Secret", stringData: { token: "abc" } });
    expect(entries).toEqual([{ key: "token", text: "abc", bytes: 3, encoded: false }]);
  });

  it("should count bytes, not characters, for multi-byte text", () => {
    const [entry] = dataEntries({ kind: "Secret", data: { greeting: b64("مرحبا") } });
    expect(entry.text).toBe("مرحبا");
    expect(entry.bytes).toBe(10);
  });

  it("should return nothing for an object with no data", () => {
    expect(dataEntries({ kind: "Secret" })).toEqual([]);
  });
});
