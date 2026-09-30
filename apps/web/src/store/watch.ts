import { create } from "zustand";
import type { KObj } from "@/lib/k8s";

/**
 * Normalized store of live-watched Kubernetes objects.
 * key = `${clusterId}|${gvrKey}|${namespace}`; value = Map<uid, object>.
 */
interface WatchEntry {
  objects: Map<string, KObj>;
  synced: boolean;
  error: string | null;
  refs: number;
}

interface WatchState {
  entries: Record<string, WatchEntry>;
  ensure(key: string): void;
  release(key: string): void;
  upsert(key: string, obj: KObj): void;
  remove(key: string, uid: string): void;
  bulk(key: string, objs: KObj[]): void;
  setSynced(key: string, synced: boolean): void;
  setError(key: string, error: string | null): void;
  reset(key: string): void;
}

const empty = (): WatchEntry => ({ objects: new Map(), synced: false, error: null, refs: 0 });

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
    const uid = obj.metadata?.uid ?? `${obj.metadata?.namespace}/${obj.metadata?.name}`;
    const objects = new Map(e.objects);
    objects.set(uid, obj);
    set({ entries: { ...get().entries, [key]: { ...e, objects } } });
  },
  bulk(key, objs) {
    const e = get().entries[key] ?? empty();
    const objects = new Map(e.objects);
    for (const obj of objs) {
      const uid = obj.metadata?.uid ?? `${obj.metadata?.namespace}/${obj.metadata?.name}`;
      objects.set(uid, obj);
    }
    set({ entries: { ...get().entries, [key]: { ...e, objects } } });
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
  setError(key, error) {
    const e = get().entries[key] ?? empty();
    set({ entries: { ...get().entries, [key]: { ...e, error } } });
  },
  reset(key) {
    const e = get().entries[key] ?? empty();
    set({ entries: { ...get().entries, [key]: { ...e, objects: new Map(), synced: false, error: null } } });
  },
}));
