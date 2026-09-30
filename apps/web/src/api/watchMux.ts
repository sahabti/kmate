/**
 * One multiplexed WebSocket per cluster carrying every resource watch.
 *
 * Why: browsers cap plain-HTTP connections at six per origin and each Connect
 * server-stream holds one, so many live tables (or the Realm view) starve the
 * page. The hub's `/ws/clusters/{id}/watch` endpoint multiplexes any number of
 * watches on a single socket (see internal/hub/ws/watch.go for the wire format).
 *
 * Handlers receive already-decoded objects. On reconnect every active
 * subscription is re-sent and its handler first gets a `reset` event so the
 * store can clear before the fresh SYNC batch arrives.
 */
import { wsUrl } from "./client";
import type { GVRKey, KObj } from "@/lib/k8s";

export type MuxEventType = "reset" | "SYNC" | "ADDED" | "MODIFIED" | "DELETED" | "ERROR" | "CLOSED" | "CATALOG" | "CLUSTER";

export interface MuxEvent {
  type: MuxEventType;
  synced?: boolean;
  object?: KObj;
  /** protojson Catalog (type CATALOG) */
  catalog?: unknown;
  /** protojson ClusterEvent (type CLUSTER) */
  event?: unknown;
  error?: { code?: number; reason?: string; message: string };
}

/** Hub-level subscription kinds carried on the same socket. */
export type MuxKind = "catalog" | "clusters";

/** Pseudo cluster id for hub-wide subscriptions (clusters list). */
export const HUB_SCOPE = "_hub";

export interface MuxOptions {
  namespace?: string;
  labelSelector?: string;
  fieldSelector?: string;
  columnsOnly?: boolean;
}

type Handler = (ev: MuxEvent) => void;

interface Sub {
  id: string;
  kind?: MuxKind;
  gvr: GVRKey;
  options: MuxOptions;
  handler: Handler;
}

const IDLE_CLOSE_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** After this many consecutive failed opens (never reached OPEN) the cluster falls back to Connect streams. */
const FALLBACK_AFTER_FAILURES = 2;

class ClusterMux {
  private ws: WebSocket | null = null;
  private open = false;
  private subs = new Map<string, Sub>();
  private nextId = 1;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private openFailures = 0;
  private everOpened = false;
  /** set once the socket failed to open twice in a row; useWatch falls back to Connect */
  fallback = false;

  constructor(private readonly clusterId: string) {}

  subscribe(gvr: GVRKey, options: MuxOptions, handler: Handler, kind?: MuxKind): () => void {
    const id = `w${this.nextId++}`;
    const sub: Sub = { id, kind, gvr, options, handler };
    this.subs.set(id, sub);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.open) this.send(subMsg(sub));
    else this.ensureOpen();
    return () => {
      if (!this.subs.delete(id)) return;
      if (this.open) this.send({ op: "unsub", id });
      if (this.subs.size === 0) this.scheduleIdleClose();
    };
  }

  private ensureOpen() {
    if (this.ws || this.reconnectTimer) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(`/ws/clusters/${encodeURIComponent(this.clusterId)}/watch`, {}));
    } catch (e) {
      this.onOpenFailure(String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.everOpened = true;
      this.openFailures = 0;
      this.backoff = BACKOFF_MIN_MS;
      for (const sub of this.subs.values()) {
        sub.handler({ type: "reset" });
        this.send(subMsg(sub));
      }
    };
    ws.onmessage = (e) => {
      let msg: { id: string; type: MuxEventType; synced?: boolean; object?: KObj; catalog?: unknown; event?: unknown; error?: MuxEvent["error"] };
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      const sub = this.subs.get(msg.id);
      if (!sub) return;
      sub.handler({ type: msg.type, synced: msg.synced, object: msg.object, catalog: msg.catalog, event: msg.event, error: msg.error });
      if (msg.type === "CLOSED") {
        // The agent-side stream ended (cluster offline, RBAC…). Retry this sub with the socket's backoff.
        setTimeout(() => {
          if (this.subs.has(msg.id) && this.open) {
            sub.handler({ type: "reset" });
            this.send(subMsg(sub));
          }
        }, this.backoff);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = (ev) => {
      const wasOpen = this.open;
      this.open = false;
      this.ws = null;
      if (!wasOpen) {
        this.onOpenFailure(ev.reason || `close ${ev.code}`);
        return;
      }
      if (this.subs.size > 0) this.scheduleReconnect();
    };
  }

  private onOpenFailure(reason: string) {
    this.openFailures++;
    if (!this.everOpened && this.openFailures >= FALLBACK_AFTER_FAILURES) {
      this.fallback = true;
      console.warn(`[kmate] watch websocket unavailable (${reason}); falling back to Connect streams for cluster ${this.clusterId}`);
      for (const sub of this.subs.values()) sub.handler({ type: "ERROR", error: { message: "websocket unavailable, falling back" } });
      return;
    }
    if (this.subs.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.backoff + Math.random() * 250;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subs.size > 0) this.ensureOpen();
    }, delay);
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.subs.size === 0) this.close();
    }, IDLE_CLOSE_MS);
  }

  private send(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    if (ws) {
      ws.onclose = null;
      ws.close(1000, "idle");
    }
  }
}

function subMsg(sub: Sub) {
  if (sub.kind) return { op: "sub", id: sub.id, kind: sub.kind };
  return {
    op: "sub",
    id: sub.id,
    gvr: { group: sub.gvr.group, version: sub.gvr.version, resource: sub.gvr.resource },
    options: {
      namespace: sub.options.namespace ?? "",
      labelSelector: sub.options.labelSelector ?? "",
      fieldSelector: sub.options.fieldSelector ?? "",
      columnsOnly: !!sub.options.columnsOnly,
    },
  };
}

const muxes = new Map<string, ClusterMux>();

function muxFor(clusterId: string): ClusterMux {
  let m = muxes.get(clusterId);
  if (!m) {
    m = new ClusterMux(clusterId);
    muxes.set(clusterId, m);
  }
  return m;
}

/** Subscribe to a watch over the cluster's multiplexed socket. Returns an unsubscribe function. */
export function subscribe(clusterId: string, gvr: GVRKey, options: MuxOptions, handler: Handler): () => void {
  return muxFor(clusterId).subscribe(gvr, options, handler);
}

/** Subscribe to a hub-level stream (Service Catalog of a cluster, or the clusters list with HUB_SCOPE). */
export function subscribeKind(clusterId: string, kind: MuxKind, handler: Handler): () => void {
  return muxFor(clusterId).subscribe({ group: "", version: "", resource: "" }, {}, handler, kind);
}

/** True when the socket could not be opened and callers should use the Connect stream instead. */
export function shouldFallback(clusterId: string): boolean {
  return muxFor(clusterId).fallback;
}
