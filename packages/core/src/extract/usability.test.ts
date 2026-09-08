import { describe, expect, it } from "vitest";
import { classifyParsedPage, classifyRenderedStatus } from "./usability.js";

const rendered = (status?: number) => ({
  finalUrl: "https://example.test/",
  html: "<main>content</main>",
  ...(status === undefined ? {} : { status }),
});
const parsed = (markdown = "A tiny but useful page.", title = "Page") => ({ title, markdown });

describe("page usability classification", () => {
  it.each([
    [404, "not_found"],
    [410, "not_found"],
    [401, "authentication_required"],
    [403, "access_denied"],
    [429, "rate_limited"],
    [503, "upstream_error"],
    [500, "upstream_error"],
    [418, "http_error"],
  ] as const)("classifies status %i before page content as %s", (status, reason) => {
    expect(classifyRenderedStatus(rendered(status))).toMatchObject({ outcome: "unusable", reason });
  });

  it.each([200, 202, 204, undefined])("allows status %s to continue to content checks", (status) => {
    expect(classifyRenderedStatus(rendered(status))).toBeUndefined();
  });

  it("withholds only wholly empty parsed content, not tiny or symbolic valid pages", () => {
    expect(classifyParsedPage(rendered(200), parsed(" \n "))).toMatchObject({
      outcome: "unusable",
      reason: "empty_content",
    });
    expect(classifyParsedPage(rendered(200), parsed("✓"))).toMatchObject({ outcome: "usable" });
    expect(classifyParsedPage(rendered(200), parsed("OK"))).toMatchObject({ outcome: "usable" });
  });

  it("recognizes the narrow GitHub interstitial conjunction without matching quotations", () => {
    const wall = {
      ...rendered(200),
      finalUrl: "https://github.com/org/repo",
    };
    expect(
      classifyParsedPage(wall, parsed("We detected unusual activity. Sign in to continue.", "Whoa there!")),
    ).toMatchObject({ outcome: "unusable", reason: "known_interstitial", signatureId: "github_whoa_there_v1" });
    expect(
      classifyParsedPage(rendered(200), parsed("We detected unusual activity. Sign in to continue.", "Whoa there!")),
    ).toMatchObject({ outcome: "usable" });
    expect(
      classifyParsedPage(
        wall,
        parsed("An article quoting: Whoa there! unusual activity; sign in to continue.", "Security research"),
      ),
    ).toMatchObject({ outcome: "usable" });
  });

  it("requires Cloudflare title, phrase, and DOM marker together", () => {
    const challenge = {
      ...rendered(200),
      html: '<div id="cf-chl-widget">Verify you are human</div>',
    };
    expect(
      classifyParsedPage(challenge, parsed("Verify you are human to continue.", "Just a moment...")),
    ).toMatchObject({
      outcome: "unusable",
      signatureId: "cloudflare_challenge_v1",
    });
    expect(
      classifyParsedPage(rendered(200), parsed("Verify you are human to continue.", "Just a moment...")),
    ).toMatchObject({ outcome: "usable" });
    expect(classifyParsedPage(challenge, parsed("Enable JavaScript", "Application"))).toMatchObject({
      outcome: "usable",
    });

    const quotedSignals = {
      ...rendered(200),
      html: '<article><pre><code>class="cf-chl-widget"; path="challenge-platform"</code></pre></article>',
    };
    expect(
      classifyParsedPage(
        quotedSignals,
        parsed("A code sample may say verify you are human and mention cf-chl-widget.", "Just a moment..."),
      ),
    ).toMatchObject({ outcome: "usable" });
  });
});
