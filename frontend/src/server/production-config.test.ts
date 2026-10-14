import { describe, expect, it } from "vitest";
import {
  clientIdentity,
  clientKey,
  hostAllowed,
  limiterFromEnv,
  parseAllowedHosts,
  sameOrigin,
} from "./production-config";

const headers = (init: Record<string, string>) => new Headers(init);
const policy = parseAllowedHosts("demo.example.test, www.example.test, example.test:8443");

describe("the host allow-list", () => {
  it("is empty when nothing is configured: only loopback names are served", () => {
    const none = parseAllowedHosts(undefined);
    expect(none).toEqual({ allowed: new Set(), invalid: null });
    expect(hostAllowed("127.0.0.1:3000", none)).toBe(true);
    expect(hostAllowed("localhost:3000", none)).toBe(true);
    expect(hostAllowed("demo.example.test", none)).toBe(false);
  });

  it("lists exact hosts, case-insensitively, and nothing else", () => {
    expect(hostAllowed("demo.example.test", policy)).toBe(true);
    expect(hostAllowed("DEMO.Example.Test", policy)).toBe(true);
    expect(hostAllowed("example.test:8443", policy)).toBe(true);
    for (const wrong of [
      "example.test", // the listed entry has a port
      "example.test:8444",
      "demo.example.test:8080",
      "evil.example.test",
      "demo.example.test.evil.test",
      "xdemo.example.test",
      "demo.example.test@evil.test",
      "demo.example.test/",
      "",
    ]) {
      expect(hostAllowed(wrong, policy), wrong).toBe(false);
    }
    expect(hostAllowed(null, policy)).toBe(false);
  });

  it.each([
    "https://demo.example.test",
    "demo.example.test/path",
    "*.example.test",
    "demo.example.test,,www.example.test",
    "demo example.test",
    "demo.example.test;evil",
    "-bad.example.test",
    "a".repeat(64) + ".test",
  ])("refuses %j and then serves no public host at all", (raw) => {
    const refused = parseAllowedHosts(raw);
    expect(refused.invalid).not.toBeNull();
    expect(refused.allowed.size).toBe(0);
    expect(hostAllowed("demo.example.test", refused)).toBe(false);
    expect(hostAllowed("127.0.0.1:3000", refused)).toBe(true); // local use is unaffected
  });

  it("limits the number of hosts", () => {
    const many = Array.from({ length: 21 }, (_, i) => `h${i}.example.test`).join(",");
    expect(parseAllowedHosts(many).invalid).not.toBeNull();
  });
});

describe("same-origin checks", () => {
  const ok = (init: Record<string, string>) => sameOrigin(headers(init), policy);

  it("accepts the site's own requests, with or without browser headers", () => {
    expect(ok({ host: "demo.example.test" })).toBe(true);
    expect(ok({ host: "demo.example.test", origin: "https://demo.example.test", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(ok({ host: "demo.example.test", origin: "http://demo.example.test" })).toBe(true);
    expect(ok({ host: "example.test:8443", origin: "https://example.test:8443" })).toBe(true);
  });

  it.each([
    ["an unknown host", { host: "evil.example.test" }],
    ["no host", {}],
    ["another site's origin", { host: "demo.example.test", origin: "https://evil.example.test" }],
    ["an origin of another listed host", { host: "demo.example.test", origin: "https://www.example.test" }],
    ["a different port in the origin", { host: "demo.example.test", origin: "https://demo.example.test:8443" }],
    ["an origin with a path", { host: "demo.example.test", origin: "https://demo.example.test/x" }],
    ["the null origin", { host: "demo.example.test", origin: "null" }],
    ["a cross-site request", { host: "demo.example.test", "sec-fetch-site": "cross-site" }],
    ["a same-site (not same-origin) request", { host: "demo.example.test", "sec-fetch-site": "same-site" }],
  ])("refuses %s", (_label, init) => {
    expect(ok(init)).toBe(false);
  });

  it("never accepts an https origin for a loopback host", () => {
    const none = parseAllowedHosts(undefined);
    expect(sameOrigin(headers({ host: "127.0.0.1:3000", origin: "https://127.0.0.1:3000" }), none)).toBe(false);
    expect(sameOrigin(headers({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), none)).toBe(true);
  });
});

describe("which client a request counts against", () => {
  const key = (init: Record<string, string>, hops: number, header: string | null = null) =>
    clientKey(headers(init), { hops, header });

  it("ignores X-Forwarded-For entirely when no proxy is trusted", () => {
    expect(key({ "x-forwarded-for": "203.0.113.7" }, 0)).toBe("unknown");
    expect(key({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" }, 0)).toBe("unknown");
  });

  it("takes the entry the trusted proxy appended, counting from the right", () => {
    expect(key({ "x-forwarded-for": "203.0.113.7" }, 1)).toBe("203.0.113.7");
    expect(key({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }, 1)).toBe("203.0.113.7");
    expect(key({ "x-forwarded-for": "203.0.113.7, 198.51.100.1" }, 2)).toBe("203.0.113.7");
  });

  it("cannot be spoofed by what the visitor puts at the front of the header", () => {
    // The visitor sent "1.2.3.4"; the single trusted proxy appended the real address.
    expect(key({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }, 1)).toBe("203.0.113.7");
    expect(key({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.7" }, 1)).toBe("203.0.113.7");
  });

  it("falls back to one shared bucket when the header is short, absent or not an address", () => {
    expect(key({}, 1)).toBe("unknown");
    expect(key({ "x-forwarded-for": "203.0.113.7" }, 2)).toBe("unknown");
    expect(key({ "x-forwarded-for": "not-an-ip" }, 1)).toBe("unknown");
    expect(key({ "x-forwarded-for": "203.0.113.7, <script>" }, 1)).toBe("unknown");
    expect(key({ "x-forwarded-for": "203.0.113.7:99" }, 1)).toBe("unknown");
  });

  it("uses a trusted edge header only when one is configured, and only if it is an address", () => {
    expect(key({ "fly-client-ip": "203.0.113.9" }, 0, "fly-client-ip")).toBe("203.0.113.9");
    expect(key({ "fly-client-ip": "2001:DB8::1" }, 0, "fly-client-ip")).toBe("2001:db8::1");
    expect(key({ "fly-client-ip": "garbage" }, 0, "fly-client-ip")).toBe("unknown");
    expect(key({ "x-forwarded-for": "203.0.113.7" }, 1, "fly-client-ip")).toBe("unknown"); // header wins, absent
    expect(key({ "fly-client-ip": "203.0.113.9" }, 0, null)).toBe("unknown"); // not configured: ignored
  });

  it("reads its configuration from the environment, bounded", () => {
    expect(clientIdentity({ BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "2", BLUEPRINTIQ_CLIENT_IP_HEADER: "Fly-Client-IP" } as unknown as NodeJS.ProcessEnv)).toEqual({ hops: 2, header: "fly-client-ip" });
    expect(clientIdentity({} as unknown as NodeJS.ProcessEnv)).toEqual({ hops: 0, header: null });
    expect(clientIdentity({ BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "99" } as unknown as NodeJS.ProcessEnv).hops).toBe(5);
    expect(clientIdentity({ BLUEPRINTIQ_TRUSTED_PROXY_HOPS: "-1", BLUEPRINTIQ_CLIENT_IP_HEADER: "bad header!" } as unknown as NodeJS.ProcessEnv)).toEqual({ hops: 0, header: null });
  });
});

describe("the limiter from the environment", () => {
  const env = (extra: Record<string, string>) => extra as unknown as NodeJS.ProcessEnv;

  it("is off unless a rate is configured, so local use is not limited", () => {
    expect(limiterFromEnv(env({}))).toBeNull();
    expect(limiterFromEnv(env({ BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "0" }))).toBeNull();
    expect(limiterFromEnv(env({ BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "abc" }))).toBeNull();
  });

  it("is one shared instance for one configuration, so every request counts against it", () => {
    const a = limiterFromEnv(env({ BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "6" }));
    const b = limiterFromEnv(env({ BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "6" }));
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(limiterFromEnv(env({ BLUEPRINTIQ_RATE_LIMIT_PER_MINUTE: "7" }))).not.toBe(a);
  });
});
