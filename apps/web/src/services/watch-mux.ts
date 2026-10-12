/**
 * One multiplexed WebSocket per cluster carrying every resource watch.
 *
 * Why: browsers cap plain-HTTP connections at six per origin and each Connect
 * server-stream holds one, so many live tables (or the Realm view) starve the
 * page. The hub's `/ws/clusters/{id}/watch` endpoint multiplexes any number of
 * watches on a single socket (see internal/hub/ws/watch.go for the wire format).
 *
 * Handlers receive already-decoded objects. When the socket drops, and again
 * on reconnect, every active subscription gets a `reset` event so the store can
 * mark its rows stale until the fresh SYNC batch replaces them.
 */
import { wsUrl } from "@/services/api-client";
import type { GVRKey, KObj } from "@/lib/k8s";
import type { WireError } from "@/lib/denial";

export type MuxEventType = "reset" | "SYNC" | "ADDED" | "MODIFIED" | "DELETED" | "ERROR" | "CLOSED" | "CATALOG" | "CLUSTER";

export interface MuxEvent {
  type: MuxEventType;
  synced?: boolean;
  object?: KObj;
  /** protojson Catalog (type CATALOG) */
  catalog?: unknown;
  /** protojson ClusterEvent (type CLUSTER) */
  event?: unknown;
  error?: WireError;
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
  /** Permission denials are permanent: stop re-subscribing and keep the message on screen. */
  denied?: boolean;
  /** Per-subscription retry delay, so one unhealthy watch cannot spin. */
  retry: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

const IDLE_CLOSE_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const SUB_RETRY_MIN_MS = 2_000;
const SUB_RETRY_MAX_MS = 60_000;

/** True when a mux error payload means "not allowed" rather than "try again". */
const isDenied = (e: MuxEvent["error"]): boolean => e?.code === 403 || e?.reason === "Forbidden";
/** After this many consecutive failed opens (never reached OPEN) the cluster falls back to Connect streams. */
const FALLBACK_AFTER_FAILURES = 2;

/** A frame from the hub: an event addressed to one subscription by id. */
interface MuxMessage extends Omit<MuxEvent, "type"> {
  id: string;
  type: MuxEventType;
}

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
    const sub: Sub = { id, kind, gvr, options, handler, retry: SUB_RETRY_MIN_MS };
    this.subs.set(id, sub);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.open) this.send(subMsg(sub));
    else this.ensureOpen();

    return () => {
      const s = this.subs.get(id);
      if (s?.retryTimer) clearTimeout(s.retryTimer);
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
        if (sub.denied) continue; // a refused watch stays refused; don't re-ask on every reconnect
        sub.handler({ type: "reset" });
        this.send(subMsg(sub));
      }
    };
    ws.onmessage = (e) => {
      let msg: MuxMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      const sub = this.subs.get(msg.id);
      if (!sub) return;

      // A permission denial is an answer, not a failure: keep it on screen and
      // stop asking, so a scoped user does not generate a retry storm.
      if ((msg.type === "ERROR" || msg.type === "CLOSED") && isDenied(msg.error)) {
        sub.denied = true;
        sub.handler({ type: "ERROR", error: msg.error });

        return;
      }

      sub.handler({ type: msg.type, synced: msg.synced, object: msg.object, catalog: msg.catalog, event: msg.event, error: msg.error });

      if (msg.type === "CLOSED") {
        // The agent-side stream ended (cluster offline, agent restart…). Retry
        // this subscription on its own growing delay.
        const delay = sub.retry + Math.random() * 250;
        sub.retry = Math.min(sub.retry * 2, SUB_RETRY_MAX_MS);
        if (sub.retryTimer) clearTimeout(sub.retryTimer);
        sub.retryTimer = setTimeout(() => {
          sub.retryTimer = undefined;
          if (this.subs.has(msg.id) && this.open && !sub.denied) {
            sub.handler({ type: "reset" });
            this.send(subMsg(sub));
          }
        }, delay);
      } else if (msg.type === "SYNC" && msg.synced) {
        sub.retry = SUB_RETRY_MIN_MS; // healthy again
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
      for (const sub of this.subs.values()) if (!sub.denied) sub.handler({ type: "reset" });
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

const subMsg = (sub: Sub) => {
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
};

const muxes = new Map<string, ClusterMux>();

const muxFor = (clusterId: string): ClusterMux => {
  let m = muxes.get(clusterId);
  if (!m) {
    m = new ClusterMux(clusterId);
    muxes.set(clusterId, m);
  }

  return m;
};

/** Subscribe to a watch over the cluster's multiplexed socket. Returns an unsubscribe function. */
export const subscribe = (clusterId: string, gvr: GVRKey, options: MuxOptions, handler: Handler): (() => void) =>
  muxFor(clusterId).subscribe(gvr, options, handler);

/** Subscribe to a hub-level stream (Service Catalog of a cluster, or the clusters list with HUB_SCOPE). */
export const subscribeKind = (clusterId: string, kind: MuxKind, handler: Handler): (() => void) =>
  muxFor(clusterId).subscribe({ group: "", version: "", resource: "" }, {}, handler, kind);

/** True when the socket could not be opened and callers should use the Connect stream instead. */
export const shouldFallback = (clusterId: string): boolean => muxFor(clusterId).fallback;
