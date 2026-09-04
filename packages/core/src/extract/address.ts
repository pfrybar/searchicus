import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ExtractFailedError, ExtractRequestError } from "./errors.js";
import type { ExtractConfig } from "./config.js";

/**
 * Address policy for rendered extraction.
 *
 * These checks are defense in depth and nothing more. Chromium ultimately
 * resolves and opens its own connections, so a name that answers publicly
 * here and privately a moment later is not caught by anything in this file —
 * the classic DNS rebinding shape. Pinning the connection would need an
 * egress proxy, which is exactly why the operator's outbound restriction is
 * the load-bearing control and this is the layer beneath it.
 *
 * What these checks do buy: the overwhelming majority of accidental and
 * casual attempts (`http://localhost:8080/admin`, `http://169.254.169.254/`,
 * a redirect into RFC 1918 space) fail immediately, cheaply, and without
 * launching a browser.
 */

/** Every DNS answer for a host, as strings. Injectable for tests. */
export type AddressLookup = (hostname: string) => Promise<string[]>;

export const resolveAddresses: AddressLookup = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/**
 * Validates the syntax of a caller-supplied URL, with no network access.
 *
 * Runs before anything is resolved or launched, so an obviously unusable
 * request costs nothing. Messages are specific because every one of these
 * failures is about input the caller wrote.
 */
export function parseExtractUrl(value: string, config: ExtractConfig): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExtractRequestError("invalid_url", "url must be an absolute http or https URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractRequestError("invalid_url", `url must use http or https, not ${url.protocol.replace(":", "")}.`);
  }

  // Credentials in a URL are a request to authenticate somewhere on the
  // caller's behalf, which this endpoint does not do for anyone.
  if (url.username || url.password) {
    throw new ExtractRequestError("invalid_url", "url must not contain credentials.");
  }

  if (!url.hostname) {
    throw new ExtractRequestError("invalid_url", "url must have a hostname.");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!config.allowedPorts.has(port)) {
    throw new ExtractRequestError(
      "invalid_url",
      `url must use an allowed port (${[...config.allowedPorts].join(", ")}).`,
    );
  }

  return url;
}

/**
 * Rejects a hostname that resolves anywhere non-public.
 *
 * Every answer must be public, not merely the first: a name with one routable
 * and one loopback address would otherwise pass here and be free to connect
 * to either.
 */
export async function assertPublicHost(hostname: string, resolve: AddressLookup = resolveAddresses): Promise<void> {
  // A literal address never needs resolving, and passing one to a resolver
  // invites a lookup that could answer differently.
  const literal = stripBrackets(hostname);
  if (isIP(literal)) {
    if (!isPublicAddress(literal)) throw ExtractFailedError.blockedAddress();
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    throw ExtractFailedError.blockedAddress(err);
  }

  if (addresses.length === 0) throw ExtractFailedError.blockedAddress();
  for (const address of addresses) {
    if (!isPublicAddress(address)) throw ExtractFailedError.blockedAddress();
  }
}

/**
 * True only for addresses on the public internet.
 *
 * Written as an allow-by-exclusion list because the failure mode of missing a
 * range is worse than the failure mode of rejecting something exotic: an
 * unlisted private range becomes reachable, while an over-broad rule only
 * makes an unusual page unextractable.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || a === undefined || b === undefined || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // RFC 6598 carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 0) return false; // IETF protocol assignments, incl. TEST-NET-1
  if (a === 192 && b === 88) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // TEST-NET-2
  if (a === 203 && b === 0) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, and broadcast

  return true;
}

function isPublicIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? "";

  // An IPv4-mapped or IPv4-compatible address is an IPv4 destination wearing
  // IPv6 notation, and must be judged as the IPv4 address it embeds.
  const embedded = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(value);
  if (embedded?.[1]) return isPublicIPv4(embedded[1]);

  if (value === "::" || value === "::1") return false; // unspecified, loopback
  if (/^fe[89ab]/.test(value)) return false; // fe80::/10 link-local
  if (/^f[cd]/.test(value)) return false; // fc00::/7 unique local
  if (/^ff/.test(value)) return false; // ff00::/8 multicast
  if (value.startsWith("2001:db8")) return false; // documentation
  if (value.startsWith("64:ff9b")) return false; // NAT64, which fronts IPv4
  if (/^100:(?::|0)/.test(value)) return false; // 100::/64 discard-only

  return true;
}

/** IPv6 hosts arrive from URL parsing wrapped in brackets. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
