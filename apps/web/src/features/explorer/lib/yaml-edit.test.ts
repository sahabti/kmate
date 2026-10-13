import { describe, expect, it } from "vitest";
import { applyBody, editVersion } from "@/features/explorer/lib/yaml-edit";

describe("versioned YAML edits", () => {
  it("should preserve a Secret edit version outside the apply body", () => {
    const original = { apiVersion: "v1", kind: "Secret", metadata: { name: "s", resourceVersion: "12", uid: "u" }, data: { keep: "a2VlcA==", remove: "cmVtb3Zl" } };
    const edited = { ...original, data: { keep: original.data.keep, added: "YWRk" } };
    const body = applyBody(edited);
    expect(body.data).toEqual(edited.data);
    expect(body.metadata).toEqual({ name: "s" });
    expect(editVersion(original)).toBe("12");
    expect(original.metadata.resourceVersion).toBe("12");
  });

  it("should require a concurrency guard for Secrets and ConfigMaps", () => {
    expect(() => editVersion({ kind: "Secret" })).toThrow(/Reload/);
    expect(editVersion({ kind: "ConfigMap", metadata: { resourceVersion: "5" } })).toBe("5");
    expect(editVersion({ kind: "Deployment", metadata: { resourceVersion: "5" } })).toBe("");
  });
});
