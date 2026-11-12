import { describe, expect, it } from "vitest";
import { ModelPool } from "./pool.ts";

describe("ModelPool", () => {
  it("picks the best model that is not resting", () => {
    let now = 0;
    const pool = new ModelPool(["a", "b", "c"], () => now);
    expect(pool.pick()).toBe("a");
    pool.rest("a", "minute", 1_000);
    expect(pool.pick()).toBe("b");
    now = 1_000;
    expect(pool.pick()).toBe("a");
  });

  it("can leave one model out", () => {
    const pool = new ModelPool(["a", "b"], () => 0);
    expect(pool.pick("a")).toBe("b");
    expect(pool.pick("b")).toBe("a");
    expect(new ModelPool(["a"], () => 0).pick("a")).toBeNull();
  });

  it("returns null when every model rests, and says which comes back first", () => {
    const pool = new ModelPool(["a", "b"], () => 0);
    pool.rest("a", "day", 9_000);
    pool.rest("b", "minute", 4_000);
    expect(pool.pick()).toBeNull();
    expect(pool.soonest()).toEqual({ until: 4_000, reason: "minute" });
  });

  it("ignores rests that are over when asked which comes back first", () => {
    let now = 0;
    const pool = new ModelPool(["a"], () => now);
    pool.rest("a", "minute", 1_000);
    now = 2_000;
    expect(pool.soonest()).toBeNull();
  });

  it("refuses an empty list", () => {
    expect(() => new ModelPool([])).toThrow();
  });
});
