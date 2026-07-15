import type { GuestClock } from "../../src/modules/terminal-view/presentation/guest/contracts";

type Sleeper = Readonly<{
  dueAt: number;
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}>;

export class ManualClock implements GuestClock {
  private currentMs = 0;
  private sleepers: Sleeper[] = [];

  now(): number {
    return this.currentMs;
  }

  sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("guest terminal load cancelled"));
        return;
      }
      this.sleepers.push({ dueAt: this.currentMs + durationMs, resolve, reject, ...(signal ? { signal } : {}) });
    });
  }

  advanceBy(durationMs: number): void {
    this.currentMs += durationMs;
    const ready = this.sleepers.filter((sleeper) => sleeper.dueAt <= this.currentMs);
    this.sleepers = this.sleepers.filter((sleeper) => sleeper.dueAt > this.currentMs);
    for (const sleeper of ready) {
      if (sleeper.signal?.aborted) sleeper.reject(new Error("guest terminal load cancelled"));
      else sleeper.resolve();
    }
  }
}
