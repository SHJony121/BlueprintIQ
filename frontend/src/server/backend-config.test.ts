import { describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_URL, parseBackendUrl } from "./backend-config";

describe("parseBackendUrl", () => {
  it("uses the documented default when unset", () => {
    expect(DEFAULT_BACKEND_URL).toBe("http://127.0.0.1:8000");
    expect(parseBackendUrl(undefined)).toEqual({ ok: true, hostname: "127.0.0.1", port: 8000 });
  });

  it.each([
    ["http://127.0.0.1:8000", "127.0.0.1", 8000],
    ["http://127.0.0.1:8000/", "127.0.0.1", 8000],
    ["http://127.0.0.1", "127.0.0.1", 80],
    ["http://127.10.20.30:9000", "127.10.20.30", 9000],
    ["http://[::1]:8000", "::1", 8000],
    ["HTTP://127.0.0.1:8000", "127.0.0.1", 8000],
    // Alternative IPv4 spellings are normalized by URL before the loopback check.
    ["http://127.1:8000", "127.0.0.1", 8000],
    ["http://0x7f.0.0.1:8000", "127.0.0.1", 8000],
    ["http://2130706433:8000", "127.0.0.1", 8000],
  ])("accepts the loopback origin %s", (raw, hostname, port) => {
    expect(parseBackendUrl(raw)).toEqual({ ok: true, hostname, port });
  });

  it.each([
    ["", "empty"],
    [" http://127.0.0.1:8000", "leading whitespace"],
    ["http://127.0.0.1:8000\n", "trailing newline"],
    ["127.0.0.1:8000", "no scheme"],
    ["not a url", "garbage"],
    ["https://127.0.0.1:8000", "https (the backend serves plain HTTP on loopback)"],
    ["ftp://127.0.0.1", "other scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["http://localhost:8000", "host name, even localhost"],
    ["http://example.com", "public host name"],
    ["http://127.0.0.1.nip.io:8000", "DNS name embedding a loopback address"],
    ["http://10.0.0.5:8000", "private address"],
    ["http://169.254.169.254", "link-local metadata address"],
    ["http://0.0.0.0:8000", "unspecified address"],
    ["http://[::]:8000", "IPv6 unspecified address"],
    ["http://[::ffff:127.0.0.1]:8000", "IPv4-mapped IPv6"],
    ["http://user:pass@127.0.0.1:8000", "credentials"],
    ["http://user@127.0.0.1:8000", "user name"],
    ["http://127.0.0.1:8000/api", "path"],
    ["http://127.0.0.1:8000/?a=1", "query"],
    ["http://127.0.0.1:8000?", "empty query"],
    ["http://127.0.0.1:8000#x", "fragment"],
    ["http://127.0.0.1:8000#", "empty fragment"],
    ["http://127.0.0.1:99999", "invalid port"],
    ["http://127.0.0.1:0", "port 0"],
  ])("refuses %j (%s)", (raw) => {
    const config = parseBackendUrl(raw);
    expect(config.ok).toBe(false);
  });

  it("never echoes the configured value in the reason", () => {
    const config = parseBackendUrl("http://secret-host.internal:8000");
    expect(config).toMatchObject({ ok: false });
    expect(JSON.stringify(config)).not.toContain("secret-host");
  });
});
