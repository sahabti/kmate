import { create } from "zustand";
import type { Denial } from "@/lib/denial";
import type { KObj } from "@/lib/k8s";

/**
 * Normalized store of live-watched Kubernetes objects.
 * key = `${clusterId}|${gvrKey}|${namespace}`; value = Map<uid, object>.
 */
interface WatchEntry {
  objects: Map<string, KObj>;
  synced: boolean;
  /**
   * Rows from before a reconnect, kept on screen until the fresh list replaces
   * them. Blanking a table on every reconnect hides data that is merely old.
   */
  stale: boolean;
  /** When the last full list arrived; lets views say how old stale rows are. */
  syncedAt: number | null;
  error: string | null;
  /** Set when the watch was refused, so views can explain instead of showing nothing. */
  denial: Denial | null;
  refs: number;
}

interface WatchState {
  entries: Record<string, WatchEntry>;
  ensure(key: string): void;
  release(key: string): void;
  upsert(key: string, obj: KObj): void;
  remove(key: string, uid: string): void;
  /** Swap in a complete list, dropping objects that vanished while disconnected. */
  replace(key: string, objs: KObj[]): void;
  setSynced(key: string, synced: boolean): void;
  setError(key: string, error: string | null, denial?: Denial | null): void;
  /** A resync is coming: keep the rows but mark them stale. */
  reset(key: string): void;
}

const empty = (): WatchEntry => ({ objects: new Map(), synced: false, stale: false, syncedAt: null, error: null, denial: null, refs: 0 });

const uidOf = (obj: KObj) => obj.metadata?.uid ?? `${obj.metadata?.namespace}/${obj.metadata?.name}`;

export const useWatchStore = create<WatchState>()((set, get) => ({
  entries: {},
  ensure(key) {
    const e = get().entries[key];
    set({ entries: { ...get().entries, [key]: e ? { ...e, refs: e.refs + 1 } : { ...empty(), refs: 1 } } });
  },
  release(key) {
    const e = get().entries[key];
    if (!e) return;
    if (e.refs <= 1) {
      const { [key]: _drop, ...rest } = get().entries;
      set({ entries: rest });
    } else {
      set({ entries: { ...get().entries, [key]: { ...e, refs: e.refs - 1 } } });
    }
  },
  upsert(key, obj) {
    const e = get().entries[key] ?? empty();
    const objects = new Map(e.objects);
    objects.set(uidOf(obj), obj);
    set({ entries: { ...get().entries, [key]: { ...e, objects } } });
  },
  replace(key, objs) {
    const e = get().entries[key] ?? empty();
    const objects = new Map<string, KObj>();
    for (const obj of objs) objects.set(uidOf(obj), obj);
    set({ entries: { ...get().entries, [key]: { ...e, objects, synced: true, stale: false, syncedAt: Date.now(), error: null, denial: null } } });
  },
  remove(key, uid) {
    const e = get().entries[key];
    if (!e) return;
    const objects = new Map(e.objects);
    objects.delete(uid);
    set({ entries: { ...get().entries, [key]: { ...e, objects } } });
  },
  setSynced(key, synced) {
    const e = get().entries[key] ?? empty();
    set({ entries: { ...get().entries, [key]: { ...e, synced } } });
  },
  setError(key, error, denial = null) {
    const e = get().entries[key] ?? empty();
    set({ entries: { ...get().entries, [key]: { ...e, error, denial } } });
  },
  reset(key) {
    const e = get().entries[key] ?? empty();
    set({ entries: { ...get().entries, [key]: { ...e, synced: false, stale: e.objects.size > 0, denial: null } } });
  },
}));
