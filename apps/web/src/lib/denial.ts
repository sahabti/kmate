import { Code, ConnectError } from "@connectrpc/connect";

/**
 * Two layers can refuse a request, and users need to know which one did:
 *
 *  - "kmate"      your grant on this hub (role, cluster, namespace scope)
 *  - "kubernetes" the cluster's own RBAC, answered by the API server
 *  - "agent"      the agent was installed read-only, so nobody can write
 *
 * Both arrive as PermissionDenied/403, so the message decides. The hub's
 * wording lives in internal/hub/auth/authz.go; anything else with a 403 came
 * from the API server through the agent.
 */
export type DenialSource = "kmate" | "kubernetes" | "agent";

export interface Denial {
  source: DenialSource;
  message: string;
}

/** Phrases the hub uses when a KMate grant refuses the request. */
const KMATE_MARKERS = [
  "is not in your grant",
  "no access to cluster",
  "cannot modify resources",
  "limited to namespaces",
  "administrator role required",
  "account is deactivated",
  "you cannot change your own role",
  "you cannot delete your own account",
  "you cannot deactivate yourself",
  // AccessReview short-circuits in the hub before it ever reaches the API server.
  "your kmate role is read-only",
  "outside your kmate grant",
];

const AGENT_MARKERS = ["agent is read-only"];

const classify = (message: string): DenialSource => {
  const m = message.toLowerCase();
  if (AGENT_MARKERS.some((s) => m.includes(s))) return "agent";
  if (KMATE_MARKERS.some((s) => m.includes(s))) return "kmate";

  return "kubernetes";
};

/** A websocket mux error payload, as the hub sends it. */
export interface WireError {
  code?: number;
  reason?: string;
  message: string;
}

/** Classifies a mux error, or null when it is not a permission problem. */
export const denialFromWire = (e: WireError | undefined | null): Denial | null => {
  if (!e?.message) return null;
  if (e.code !== 403 && e.reason !== "Forbidden") return null;

  return { source: classify(e.message), message: e.message };
};

/** Classifies a thrown error (Connect or otherwise), or null when it is not a denial. */
export const denialFromError = (e: unknown): Denial | null => {
  if (e instanceof ConnectError) {
    if (e.code !== Code.PermissionDenied) return null;
    const message = e.rawMessage || e.message;

    return { source: classify(message), message };
  }

  return null;
};

/** Human sentence naming which layer refused, for a heading or tooltip. */
export const denialHeadline = (d: Denial): string => {
  switch (d.source) {
    case "kmate":
      return "Your KMate access does not allow this";
    case "agent":
      return "The agent is installed read-only";
    case "kubernetes":
      return "The cluster's RBAC does not allow this";
  }
};

/** Short label for a badge or inline note. */
export const denialLayer = (d: Denial): string => {
  switch (d.source) {
    case "kmate":
      return "KMate access";
    case "agent":
      return "agent read-only";
    case "kubernetes":
      return "cluster RBAC";
  }
};

/** What the user can do about it. */
export const denialHint = (d: Denial): string => {
  switch (d.source) {
    case "kmate":
      return "Ask a KMate administrator to widen your grant on this cluster.";
    case "agent":
      return "Reinstall the agent with rbac.write=true (and rbac.exec=true for terminals) to allow changes.";
    case "kubernetes":
      return "Ask a cluster administrator for a Role or ClusterRole binding that covers this.";
  }
};

/**
 * Classifies a free-text reason (for example from an access review) by the layer
 * that produced it, so a tooltip names the right one.
 */
export const denialFromReason = (reason: string): DenialSource => {
  return classify(reason);
};
