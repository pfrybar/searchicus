import type { PageUnusableReason, ParsedDocument, RenderedPage } from "./types.js";

export const PAGE_USABILITY_CLASSIFIER_VERSION = "1";

// Structural attributes only. Plain prose or an escaped code sample that
// merely names these tokens is not evidence that the challenge owns the DOM.
const CLOUDFLARE_CHALLENGE_ELEMENT =
  /<(?:div|form|iframe|script)\b[^>]{0,2000}\b(?:id|class)=["'][^"']*\bcf-chl-[^"']*["'][^>]*>/i;
const CLOUDFLARE_CHALLENGE_SCRIPT = /<script\b[^>]{0,2000}\bsrc=["'][^"']*\/challenge-platform\/[^"']*["'][^>]*>/i;

export type PageAssessment =
  | { readonly outcome: "usable"; readonly classifierVersion: typeof PAGE_USABILITY_CLASSIFIER_VERSION }
  | {
      readonly outcome: "unusable";
      readonly reason: PageUnusableReason;
      readonly classifierVersion: typeof PAGE_USABILITY_CLASSIFIER_VERSION;
      readonly signatureId?: "github_whoa_there_v1" | "cloudflare_challenge_v1";
    };

/** Status-only assessment. Call before parsing so remote error bodies are never treated as documents. */
export function classifyRenderedStatus(rendered: Pick<RenderedPage, "status">): PageAssessment | undefined {
  const status = rendered.status;
  if (status === undefined || (status >= 200 && status < 300)) return undefined;
  if (status === 404 || status === 410) return unusable("not_found");
  if (status === 401) return unusable("authentication_required");
  if (status === 403) return unusable("access_denied");
  if (status === 429) return unusable("rate_limited");
  if (status >= 500 && status < 600) return unusable("upstream_error");
  return unusable("http_error");
}

/** Conservative content assessment for status-eligible documents. */
export function classifyParsedPage(
  rendered: Pick<RenderedPage, "finalUrl" | "html">,
  parsed: Pick<ParsedDocument, "title" | "markdown">,
): PageAssessment {
  if (parsed.markdown.trim().length === 0) return unusable("empty_content");

  const title = normalize(parsed.title).slice(0, 200);
  const text = normalize(parsed.markdown).slice(0, 20_000);
  const html = rendered.html.slice(0, 100_000).toLowerCase();
  const hostname = hostnameOf(rendered.finalUrl);

  // Host, exact title, two distinctive phrases, and a size ceiling are all
  // required. Articles that quote this interstitial remain usable.
  if (
    hostname === "github.com" &&
    title === "whoa there!" &&
    parsed.markdown.length <= 4_000 &&
    text.includes("unusual activity") &&
    (text.includes("sign in") || text.includes("continue"))
  ) {
    return {
      outcome: "unusable",
      reason: "known_interstitial",
      classifierVersion: PAGE_USABILITY_CLASSIFIER_VERSION,
      signatureId: "github_whoa_there_v1",
    };
  }

  // Cloudflare's exact title and DOM marker corroborate the human-verification
  // language. No one phrase, short body, or generic JavaScript warning is
  // sufficient on its own.
  if (
    title === "just a moment..." &&
    parsed.markdown.length <= 8_000 &&
    (text.includes("verify you are human") || text.includes("performing security verification")) &&
    (CLOUDFLARE_CHALLENGE_ELEMENT.test(html) || CLOUDFLARE_CHALLENGE_SCRIPT.test(html))
  ) {
    return {
      outcome: "unusable",
      reason: "known_interstitial",
      classifierVersion: PAGE_USABILITY_CLASSIFIER_VERSION,
      signatureId: "cloudflare_challenge_v1",
    };
  }

  return { outcome: "usable", classifierVersion: PAGE_USABILITY_CLASSIFIER_VERSION };
}

function unusable(reason: PageUnusableReason): PageAssessment {
  return { outcome: "unusable", reason, classifierVersion: PAGE_USABILITY_CLASSIFIER_VERSION };
}

function normalize(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
