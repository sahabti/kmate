interface SharedWatch {
  refs: number;
  stop: () => void;
}

const watches = new Map<string, SharedWatch>();

/** The last consumer closes the transport, regardless of which one opened it. */
export const retainWatch = (key: string, start: () => () => void): (() => void) => {
  let watch = watches.get(key);
  if (!watch) {
    watch = { refs: 0, stop: start() };
    watches.set(key, watch);
  }
  watch.refs++;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    watch.refs--;
    if (watch.refs === 0) {
      watches.delete(key);
      watch.stop();
    }
  };
};
