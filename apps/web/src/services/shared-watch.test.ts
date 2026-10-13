import { describe, expect, it, vi } from "vitest";
import { retainWatch } from "@/services/shared-watch";

describe("shared watch lifetime", () => {
  it("should keep the stream when its first consumer unmounts", () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const first = retainWatch("first-unmount", start);
    const second = retainWatch("first-unmount", start);
    expect(start).toHaveBeenCalledTimes(1);
    first();
    expect(stop).not.toHaveBeenCalled();
    second();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("should release once and reopen after the last consumer leaves", () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    const release = retainWatch("reopen", start);
    release();
    release();
    expect(stop).toHaveBeenCalledTimes(1);
    const next = retainWatch("reopen", start);
    expect(start).toHaveBeenCalledTimes(2);
    next();
  });
});
