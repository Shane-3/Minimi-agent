// Which model answers next. Models are tried best first; one that hits a
// limit or fails rests for a while and the next is used. Free-tier limits are
// counted per model, so a pool of several answers more questions a day.

export type RestReason =
  /** Hit the per-minute request limit. */
  | "minute"
  /** Used up its daily request limit. */
  | "day"
  /** Overloaded, a server error, or a timeout. */
  | "failure";

export interface Rest {
  /** Epoch milliseconds when the model may be used again. */
  until: number;
  reason: RestReason;
}

export class ModelPool {
  private readonly models: string[];
  private readonly now: () => number;
  private readonly rests = new Map<string, Rest>();

  constructor(models: string[], now: () => number = () => Date.now()) {
    if (models.length === 0) throw new Error("The model pool needs at least one model.");
    this.models = models;
    this.now = now;
  }

  /** The best model that is not resting, other than `except`; null when there is none. */
  pick(except?: string): string | null {
    const now = this.now();
    return this.models.find((model) => model !== except && (this.rests.get(model)?.until ?? 0) <= now) ?? null;
  }

  rest(model: string, reason: RestReason, ms: number): void {
    this.rests.set(model, { until: this.now() + ms, reason });
  }

  /**
   * Of the models resting now, the one free soonest. When none is available,
   * its reason says what to tell the user: a daily limit means every model
   * is out for the day; otherwise a short wait will do.
   */
  soonest(): Rest | null {
    const now = this.now();
    let best: Rest | null = null;
    for (const rest of this.rests.values()) {
      if (rest.until > now && (best === null || rest.until < best.until)) best = rest;
    }
    return best;
  }
}
