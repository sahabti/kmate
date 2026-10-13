import type { KObj } from "@/lib/k8s";

/** Server-generated fields cannot be part of the declarative edit. */
export const applyBody = (obj: KObj): KObj => {
  const { status: _status, ...rest } = obj;
  const metadata = { ...(rest.metadata ?? {}) } as Record<string, unknown>;
  for (const key of ["managedFields", "uid", "creationTimestamp", "generation", "resourceVersion", "selfLink"]) delete metadata[key];

  return { ...rest, metadata } as KObj;
};

/** A versioned Secret/ConfigMap edit lets the agent delete omitted keys explicitly. */
export const editVersion = (obj: KObj): string => {
  if (obj.kind !== "Secret" && obj.kind !== "ConfigMap") return "";
  if (!obj.metadata?.resourceVersion) throw new Error("Reload this object before editing; its resource version is missing.");

  return obj.metadata.resourceVersion;
};
