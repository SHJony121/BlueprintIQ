import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit";

function limiter(overrides: Partial<ConstructorParameters<typeof RateLimiter>[0]> = {}) {
  const clock = { now: 1_000_000 };
  const instance = new RateLimiter({
    perMinute: 6,
    burst: 3,
    maxConcurrent: 2,
    maxClients: 100,
    now: () => clock.now,
    ...overrides,
  });
  return { instance, clock };
}

describe("the per-client limiter", () => {
  it("lets a burst through, then refuses with a retry time", () => {
    const { instance } = limiter();
    for (let i = 0; i < 3; i++) {
      const ticket = instance.acquire("a");
      expect(ticket.ok).toBe(true);
      if (ticket.ok) ticket.release();
    }
    const refused = instance.acquire("a");
    expect(refused).toMatchObject({ ok: false, reason: "rate" });
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills at the configured rate", () => {
    const { instance, clock } = limiter();
    for (let i = 0; i < 3; i++) (instance.acquire("a") as { release: () => void }).release();
    expect(instance.acquire("a").ok).toBe(false);
    clock.now += 9_000; // 6 per minute is one per 10 s: not yet
    expect(instance.acquire("a").ok).toBe(false);
    clock.now += 1_500;
    const ticket = instance.acquire("a");
    expect(ticket.ok).toBe(true);
  });

  it("never refills beyond the burst", () => {
    const { instance, clock } = limiter();
    clock.now += 3_600_000;
    const taken: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const t = instance.acquire("a");
      taken.push(t.ok);
      if (t.ok) t.release();
    }
    expect(taken).toEqual([true, true, true, false, false]);
  });

  it("keeps clients apart", () => {
    const { instance } = limiter({ burst: 1, maxConcurrent: 5 });
    expect(instance.acquire("a").ok).toBe(true);
    expect(instance.acquire("a").ok).toBe(false);
    expect(instance.acquire("b").ok).toBe(true);
  });

  it("caps uploads running at once per client and frees the slot on release", () => {
    const { instance } = limiter({ burst: 10, maxConcurrent: 2 });
    const one = instance.acquire("a");
    const two = instance.acquire("a");
    expect(one.ok && two.ok).toBe(true);
    expect(instance.acquire("a")).toMatchObject({ ok: false, reason: "concurrent" });
    expect(instance.acquire("b").ok).toBe(true); // another client is not affected
    if (one.ok) one.release();
    expect(instance.acquire("a").ok).toBe(true);
  });

  it("releases a slot only once, however often release is called", () => {
    const { instance } = limiter({ burst: 10, maxConcurrent: 1 });
    const one = instance.acquire("a");
    if (!one.ok) throw new Error("expected a ticket");
    one.release();
    one.release();
    one.release();
    const two = instance.acquire("a");
    expect(two.ok).toBe(true);
    expect(instance.acquire("a")).toMatchObject({ ok: false, reason: "concurrent" });
  });

  it("bounds its memory by dropping idle clients, never one with an upload running", () => {
    const { instance, clock } = limiter({ maxClients: 20, burst: 1000, maxConcurrent: 2 });
    const busy = instance.acquire("busy");
    expect(busy.ok).toBe(true);
    for (let i = 0; i < 500; i++) {
      clock.now += 10;
      const t = instance.acquire(`client-${i}`);
      if (t.ok) t.release();
    }
    expect(instance.size).toBeLessThanOrEqual(21);
    // The client with a running upload kept its record: its slot is still counted.
    expect(instance.acquire("busy").ok).toBe(true);
    expect(instance.acquire("busy")).toMatchObject({ ok: false, reason: "concurrent" });
  });
});
