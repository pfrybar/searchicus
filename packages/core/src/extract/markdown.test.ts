import { describe, expect, it, vi } from "vitest";
import { createWorkerParser } from "./markdown.js";

const parse = createWorkerParser();
const never = new AbortController().signal;

const ARTICLE = `<!doctype html><html lang="en"><head>
<title>Waterparks of Chicago</title>
<meta name="author" content="A Reporter">
<meta property="article:published_time" content="2026-01-02">
<style>.noise { color: red }</style>
<script>window.tracker = 1;</script>
</head><body>
<nav><a href="/">Home</a><a href="/ads">Sponsored</a></nav>
<article>
  <h1>Waterparks of Chicago</h1>
  <p>The <b>best</b> waterpark in Chicago is a matter of debate.</p>
  <ul><li>Whitewater</li><li>Pelican Harbor</li></ul>
  <pre><code>const x = 1;</code></pre>
  <img src="https://example.test/pool.png" alt="a pool">
</article>
<footer>Subscribe to our newsletter</footer>
</body></html>`;

describe("createWorkerParser", () => {
  it("returns readable Markdown with the page's boilerplate removed", async () => {
    const parsed = await parse(ARTICLE, "https://example.test/chicago", never);

    expect(parsed.title).toBe("Waterparks of Chicago");
    expect(parsed.markdown).toContain("**best** waterpark in Chicago");
    expect(parsed.markdown).toContain("- Whitewater");
    expect(parsed.markdown).toContain("const x = 1;");
    // The things that would otherwise spend a caller's context for nothing.
    expect(parsed.markdown).not.toContain("Sponsored");
    expect(parsed.markdown).not.toContain("newsletter");
    expect(parsed.markdown).not.toContain("window.tracker");
    expect(parsed.markdown).not.toContain("color: red");
    expect(parsed.markdown).not.toContain("pool.png");
  });

  it("carries back the metadata the archive records", async () => {
    const parsed = await parse(ARTICLE, "https://example.test/chicago", never);

    expect(parsed).toMatchObject({ author: "A Reporter", published: "2026-01-02", language: "en" });
    expect(parsed.wordCount).toBeGreaterThan(0);
  });

  it("returns nothing readable for a page that has nothing", async () => {
    // The service turns this into a no_content failure rather than an empty
    // success, so the parser only has to be honest about it.
    const parsed = await parse("<html><body></body></html>", "https://example.test/", never);

    expect(parsed.markdown.trim()).toBe("");
  });

  it("survives malformed markup instead of throwing", async () => {
    // linkedom repairs the tree and Defuddle scores what is left, which for a
    // fragment this thin is nothing. Resolving empty is the contract that
    // matters here: the service turns it into no_content, where throwing
    // would surface as an opaque parse failure.
    await expect(parse("<p>unclosed <b>tags <div>everywhere", "https://example.test/", never)).resolves.toMatchObject({
      markdown: "",
    });
  });

  it("parses a page whose own canonical URL is relative, quietly", async () => {
    // The reported failure. Defuddle reads doc.location.href first and
    // linkedom has no location, so it fell through to the page's own
    // canonical — and `href="photo"` is not a URL, so every such extraction
    // logged "Failed to parse URL: TypeError: Invalid URL" from inside the
    // worker into the API's log. Root-relative canonicals are everywhere, so
    // this was not a rare page.
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const parsed = await parse(
        `<!doctype html><html lang="en"><head><title>A Photo Story</title>
         <link rel="canonical" href="photo"></head>
         <body><article><h1>A Photo Story</h1><p>Readable prose about the photograph.</p></article></body></html>`,
        "https://example.test/stories/photo-story",
        never,
      );

      expect(parsed.markdown).toContain("Readable prose about the photograph.");
      // The worker's streams are captured rather than inherited, so nothing
      // a page provokes the parser into printing reaches the server log.
      expect(written.join("")).not.toMatch(/Failed to parse URL/);
    } finally {
      spy.mockRestore();
    }
  });

  it("is not told its own address by the page it is reading", async () => {
    // A page supplying an absolute og:url used to decide what Defuddle
    // believed its domain was, and that value feeds Defuddle's title
    // cleaning. The URL actually fetched is the one that should win.
    const page = (head: string) =>
      `<!doctype html><html lang="en"><head><title>A Photo Story | Example</title>${head}</head>
       <body><article><h1>A Photo Story</h1><p>Readable prose about the photograph.</p></article></body></html>`;

    const honest = await parse(page(""), "https://example.test/stories/photo", never);
    const hostile = await parse(
      page(`<meta property="og:url" content="https://attacker.test/evil">`),
      "https://example.test/stories/photo",
      never,
    );

    expect(hostile.title).toBe(honest.title);
    expect(hostile.markdown).toBe(honest.markdown);
  });

  it("abandons a parse whose extraction was cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(parse(ARTICLE, "https://example.test/", controller.signal)).rejects.toThrow(/cancelled/);
  });
});
