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
    throw new ExtractRequestError("url must be an absolute http or https URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractRequestError(`url must use http or https, not ${url.protocol.replace(":", "")}.`);
  }

  // Credentials in a URL are a request to authenticate somewhere on the
  // caller's behalf, which this endpoint does not do for anyone.
  if (url.username || url.password) {
    throw new ExtractRequestError("url must not contain credentials.");
  }

  if (!url.hostname) {
    throw new ExtractRequestError("url must have a hostname.");
  }

  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!config.allowedPorts.has(port)) {
    throw new ExtractRequestError(`url must use an allowed port (${[...config.allowedPorts].join(", ")}).`);
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
 *
 * Ranges are matched against the parsed address, never against how it was
 * written. IPv6 has several spellings per destination and `new URL()`
 * rewrites between them, so a rule that matches notation is a rule that can
 * be spelled around.
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
  const groups = expandIPv6(address.split("%")[0] ?? "");
  if (!groups) return false;

  const [a, b, c, d, e, f, g, h] = groups;
  const topFiveZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;

  // Checked before the embedded-IPv4 rules below, which would otherwise
  // absorb both: ::1 is ::0.0.0.1 read as IPv4-compatible.
  if (groups.every((group) => group === 0)) return false; // :: unspecified
  if (topFiveZero && f === 0 && g === 0 && h === 1) return false; // ::1 loopback

  // Every "this is really IPv4" encoding, judged as the address it embeds
  // rather than as the text it was written in. Deciding from the sixteen
  // bytes is the point: one destination has several spellings and the WHATWG
  // URL parser rewrites between them, so a rule matching notation checks a
  // form that may never arrive. `::ffff:127.0.0.1` reaches here as
  // `::ffff:7f00:1`, re-serialized to hex by `new URL()`.
  //
  // ::ffff:0:0/96 (mapped) and ::/96 (compatible) carry it in the last two
  // groups.
  if (topFiveZero && (f === 0xffff || f === 0)) return isPublicIPv4Words(g, h);

  // 64:ff9b::/96 is NAT64, which fronts IPv4. Anything else under that
  // prefix — the /48 local-use form included — is refused outright rather
  // than guessed at: it exists to reach IPv4, and where is not readable here.
  if (a === 0x64 && b === 0xff9b) {
    return c === 0 && d === 0 && e === 0 && f === 0 ? isPublicIPv4Words(g, h) : false;
  }

  // 6to4 and Teredo also front IPv4, but both are deprecated transition
  // mechanisms with no live content behind them, so the whole prefix is
  // refused rather than unwrapped. That is the safer of the two available
  // mistakes here — an over-broad rule costs an unextractable page, an
  // under-broad one hands out a reachable private address — and it removes
  // the only rule that had to reason about a bitwise-inverted address.
  if (a === 0x2002) return false; // 2002::/16 6to4
  if (a === 0x2001 && b === 0) return false; // 2001::/32 Teredo

  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (a === 0x2001 && b === 0x0db8) return false; // 2001:db8::/32 documentation
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // 100::/64 discard-only

  return true;
}

/** Judges the IPv4 address held in two 16-bit groups. */
function isPublicIPv4Words(high: number, low: number): boolean {
  return isPublicIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
}

/** The eight 16-bit groups of an IPv6 address, as a fixed-length tuple. */
type IPv6Groups = [number, number, number, number, number, number, number, number];

/**
 * Expands any IPv6 spelling into its eight 16-bit groups.
 *
 * Returns undefined for anything that is not an IPv6 address, so a caller
 * that cannot understand a value refuses it rather than defaulting to public.
 */
function expandIPv6(value: string): IPv6Groups | undefined {
  if (isIP(value) !== 6) return undefined;

  let text = value.toLowerCase();

  // A trailing dotted quad occupies the last two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1]) {
    const octets = dotted[1].split(".").map(Number);
    const [o0 = 0, o1 = 0, o2 = 0, o3 = 0] = octets;
    text = text.slice(0, dotted.index) + hex(o0, o1) + ":" + hex(o2, o3);
  }

  const [head, tail, extra] = text.split("::");
  if (extra !== undefined) return undefined; // "::" may appear only once

  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];

  if (groups.length !== 8) return undefined;

  const parsed = groups.map((group) => parseInt(group, 16));
  if (parsed.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
  // Length was checked above; the cast is what lets callers destructure eight
  // definite numbers instead of eight `number | undefined`s.
  return parsed as IPv6Groups;
}

function hex(high: number, low: number): string {
  return ((high << 8) | low).toString(16);
}

/** IPv6 hosts arrive from URL parsing wrapped in brackets. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
