import { describe, expect, it } from "vitest";
import { assertPublicHost, isPublicAddress, parseExtractUrl } from "./address.js";
import { DEFAULT_EXTRACT_CONFIG } from "./config.js";
import { ExtractFailedError, ExtractRequestError } from "./errors.js";

const config = DEFAULT_EXTRACT_CONFIG;

describe("parseExtractUrl", () => {
  it("accepts ordinary web URLs on their default ports", () => {
    expect(parseExtractUrl("https://example.com/a?b=1#c", config).toString()).toBe("https://example.com/a?b=1#c");
    expect(parseExtractUrl("http://example.com:80/", config).hostname).toBe("example.com");
    expect(parseExtractUrl("https://example.com:443/", config).hostname).toBe("example.com");
  });

  it("refuses schemes that are not the web", () => {
    for (const value of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi", "javascript:alert(1)"]) {
      expect(() => parseExtractUrl(value, config)).toThrow(ExtractRequestError);
    }
  });

  it("refuses relative and malformed input", () => {
    for (const value of ["/just/a/path", "example.com", "", "http://"]) {
      expect(() => parseExtractUrl(value, config)).toThrow(ExtractRequestError);
    }
  });

  it("refuses embedded credentials rather than authenticating for a caller", () => {
    expect(() => parseExtractUrl("https://user:pass@example.com/", config)).toThrow(/must not contain credentials/);
  });

  it("refuses ports outside the allowed set", () => {
    // The shape that matters: a service listening somewhere unusual on a host
    // whose name resolves publicly.
    expect(() => parseExtractUrl("http://example.com:8080/admin", config)).toThrow(/allowed port/);
    expect(() => parseExtractUrl("http://example.com:22/", config)).toThrow(/allowed port/);
  });
});

describe("isPublicAddress", () => {
  it("rejects every private, local, and reserved IPv4 range", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1", // carrier-grade NAT
      "169.254.169.254", // the cloud metadata address
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.5", // TEST-NET-1
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("accepts routable IPv4", () => {
    for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it("rejects every private, local, and reserved IPv6 range", () => {
    for (const address of [
      "::",
      "::1",
      "fe80::1", // link-local
      "febf::1",
      "fc00::1", // unique local
      "fd12:3456::1",
      "ff02::1", // multicast
      "2001:db8::1", // documentation
      "64:ff9b::1", // NAT64, which fronts IPv4
      "100::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("judges an IPv4-mapped address as the IPv4 address it embeds", () => {
    // The bypass this closes: ::ffff:127.0.0.1 is loopback wearing IPv6
    // notation, and would otherwise pass every IPv6 rule above.
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::127.0.0.1")).toBe(false);
  });

  it("accepts routable IPv6 and rejects anything that is not an address", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("never resolves a literal address, and judges it directly", async () => {
    let resolved = false;
    const lookup = async () => {
      resolved = true;
      return ["8.8.8.8"];
    };

    await expect(assertPublicHost("127.0.0.1", lookup)).rejects.toThrow(ExtractFailedError);
    await expect(assertPublicHost("[::1]", lookup)).rejects.toThrow(ExtractFailedError);
    await expect(assertPublicHost("8.8.4.4", lookup)).resolves.toBeUndefined();
    expect(resolved).toBe(false);
  });

  it("requires every answer to be public, not merely the first", async () => {
    // A name answering with one routable and one loopback address would
    // otherwise pass, then be free to connect to either.
    await expect(assertPublicHost("split.example", async () => ["93.184.216.34", "127.0.0.1"])).rejects.toThrow(
      ExtractFailedError,
    );
    await expect(assertPublicHost("good.example", async () => ["93.184.216.34", "1.1.1.1"])).resolves.toBeUndefined();
  });

  it("treats an empty or failing resolution as a refusal", async () => {
    await expect(assertPublicHost("nothing.example", async () => [])).rejects.toThrow(ExtractFailedError);
    await expect(assertPublicHost("broken.example", () => Promise.reject(new Error("ENOTFOUND")))).rejects.toThrow(
      ExtractFailedError,
    );
  });

  it("says nothing about what it found", async () => {
    // The message must not let a caller map internal space by probing names.
    const err = await assertPublicHost("internal.example", async () => ["10.0.0.5"]).catch((e: unknown) => e);
    expect(String((err as Error).message)).toBe("That URL could not be fetched.");
    expect(String((err as Error).message)).not.toContain("10.0.0.5");
  });
});
