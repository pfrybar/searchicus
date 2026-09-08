import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACT_CONFIG, type ExtractConfig } from "../extract/config.js";
import { ExtractFailedError } from "../extract/errors.js";
import { ExtractionBrowser } from "./extract-browser.js";

/** See session.test.ts: probe once, then skip where no browser exists. */
async function chromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const available = await chromiumAvailable();
const servers: Server[] = [];
const browsers: ExtractionBrowser[] = [];

/**
 * A real local origin, served over loopback.
 *
 * Loopback is precisely what the address policy exists to refuse, and the
 * policy will not be talked out of it — it never resolves a literal address,
 * so no fake resolver can wave 127.0.0.1 through. These tests therefore
 * replace the check outright. That keeps them honest about what they cover:
 * the policy is proven in address.test.ts, and what needs a real browser is
 * request routing, readiness, redirects, and context isolation.
 */
async function serve(
  routes: Record<string, { body: string; type?: string; status?: number; location?: string }>,
): Promise<string> {
  return listen(
    createServer((req, res) => {
      const route = routes[req.url ?? "/"];
      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }
      const headers: Record<string, string> = { "content-type": route.type ?? "text/html" };
      if (route.location) headers.location = route.location;
      res.writeHead(route.status ?? 200, headers).end(route.body);
    }),
  );
}

/** listen() is asynchronous, so the port is not knowable until it fires. */
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A browser that will talk to `origin`.
 *
 * The stub servers take an ephemeral port, which the default policy refuses —
 * correctly, since 80 and 443 are the whole allowed set. Naming the port here
 * rather than widening the range keeps that rule real: the port check is
 * still doing its job in every one of these tests.
 */
function extractionBrowser(origin: string, overrides: Partial<ExtractConfig> = {}): ExtractionBrowser {
  const browser = new ExtractionBrowser({
    config: {
      ...DEFAULT_EXTRACT_CONFIG,
      enabled: true,
      dwell: false,
      settleTimeoutMs: 50,
      allowedPorts: new Set([80, 443, Number(new URL(origin).port)]),
      ...overrides,
    },
    assertAddress: async () => undefined,
  });
  browsers.push(browser);
  return browser;
}

const never = new AbortController().signal;

afterAll(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  for (const server of servers) server.close();
});

describe.skipIf(!available)("ExtractionBrowser (live Chromium)", () => {
  it("renders after scripts have run, which is the reason for a browser at all", async () => {
    const origin = await serve({
      "/": {
        body: `<html><body><div id="app"></div>
          <script>document.getElementById("app").innerHTML = "<h1>Hydrated</h1><p>Only JavaScript put this here.</p>";</script>
        </body></html>`,
      },
    });

    const page = await extractionBrowser(origin).render(`${origin}/`, never);

    expect(page.html).toContain("Only JavaScript put this here.");
    expect(page.status).toBe(200);
    expect(page.contentType).toBe("text/html");
    expect(page.finalUrl).toBe(`${origin}/`);
  });

  it("never starts Chromium until something asks it to render", () => {
    expect(extractionBrowser("http://127.0.0.1:80").launched).toBe(false);
  });

  it("refuses a port outside the allowed set", async () => {
    const origin = await serve({ "/": { body: "<html><body>admin</body></html>" } });
    const browser = new ExtractionBrowser({
      config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true, dwell: false },
      assertAddress: async () => undefined,
    });
    browsers.push(browser);

    // A service on an unusual port behind a publicly-resolving name is the
    // shape the port rule exists for.
    await expect(browser.render(`${origin}/`, never)).rejects.toBeInstanceOf(ExtractFailedError);
  });

  it("carries no cookies between extractions", async () => {
    const origin = await serve({
      "/set": { body: "<html><body>set</body></html>" },
      "/read": { body: "<html><body>read</body></html>" },
    });
    const browser = extractionBrowser(origin);

    await browser.render(`${origin}/set`, never);
    const second = await browser.render(`${origin}/read`, never);

    // Each extraction gets a fresh context, so a page cannot leave state for
    // the next caller's page to find — and none of it touches the search
    // profile, which lives in a different process entirely.
    expect(second.html).not.toContain("set");
  });

  it("loads scripts and stylesheets but refuses images and fonts", async () => {
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? "");
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" })
          .end(`<html><head><link rel="stylesheet" href="/s.css"></head><body>
            <img src="/i.png"><script src="/j.js"></script></body></html>`);
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("x");
    });
    const origin = await listen(server);

    await extractionBrowser(origin).render(`${origin}/`, never);

    expect(requested).toContain("/s.css");
    expect(requested).toContain("/j.js");
    // Defuddle discards images anyway, so fetching them is bandwidth spent on
    // bytes that could never reach the caller.
    expect(requested).not.toContain("/i.png");
  });

  it("refuses iframes rather than rendering a second document", async () => {
    const requested: string[] = [];
    const server = createServer((req, res) => {
      requested.push(req.url ?? "");
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(req.url === "/" ? `<html><body><iframe src="/frame"></iframe></body></html>` : "<html>inner</html>");
    });
    const origin = await listen(server);

    const page = await extractionBrowser(origin).render(`${origin}/`, never);

    expect(requested).not.toContain("/frame");
    expect(page.html).not.toContain("inner");
  });

  it("counts redirects and refuses a chain past the cap", async () => {
    const origin = await serve({
      "/a": { body: "", status: 302, location: "/b" },
      "/b": { body: "", status: 302, location: "/c" },
      "/c": { body: "<html><body><p>Arrived after two hops.</p></body></html>" },
    });

    const page = await extractionBrowser(origin, { maxRedirects: 5 }).render(`${origin}/a`, never);
    expect(page.redirects).toBe(2);
    expect(page.finalUrl).toBe(`${origin}/c`);

    await expect(extractionBrowser(origin, { maxRedirects: 1 }).render(`${origin}/a`, never)).rejects.toBeInstanceOf(
      ExtractFailedError,
    );
  });

  it("lands on the destination, so its own relative assets resolve against it", async () => {
    // The bug this pins: the destination's body used to be fulfilled against
    // the *original* request, leaving the document's URL — and so its origin,
    // and so the base for every relative URL in it — set to the address that
    // only redirected. A page reached through a shortener then asked the
    // shortener for its script, got a 404, and rendered as an empty shell:
    // exactly the failure a browser was chosen to avoid.
    const asked: { redirector: string[]; destination: string[] } = { redirector: [], destination: [] };

    const destination = await listen(
      createServer((req, res) => {
        asked.destination.push(req.url ?? "");
        if (req.url === "/article") {
          res
            .writeHead(200, { "content-type": "text/html" })
            .end(`<html><body><div id="app">no script ran</div><script src="/app.js"></script></body></html>`);
        } else if (req.url === "/app.js") {
          res
            .writeHead(200, { "content-type": "text/javascript" })
            .end('document.getElementById("app").textContent = "the destination own script ran";');
        } else res.writeHead(404).end("no");
      }),
    );

    const redirector = await listen(
      createServer((req, res) => {
        asked.redirector.push(req.url ?? "");
        if (req.url === "/go") res.writeHead(302, { location: `${destination}/article` }).end();
        else res.writeHead(404).end("this host serves nothing but the redirect");
      }),
    );

    const browser = new ExtractionBrowser({
      config: {
        ...DEFAULT_EXTRACT_CONFIG,
        enabled: true,
        dwell: false,
        settleTimeoutMs: 100,
        allowedPorts: new Set([80, 443, Number(new URL(redirector).port), Number(new URL(destination).port)]),
      },
      assertAddress: async () => undefined,
    });
    browsers.push(browser);

    const page = await browser.render(`${redirector}/go`, never);

    expect(page.finalUrl).toBe(`${destination}/article`);
    expect(page.html).toContain("the destination own script ran");
    // The redirector is asked for the redirect and nothing else; the
    // destination serves its own page and its own script.
    expect(asked.redirector).toEqual(["/go"]);
    expect(asked.destination).toEqual(["/article", "/app.js"]);
  });

  it("screens every redirect destination, not just the URL it was given", async () => {
    const origin = await serve({
      "/open-redirect": { body: "", status: 302, location: "http://metadata.internal/latest/meta-data/" },
    });
    const screened: string[] = [];
    const browser = new ExtractionBrowser({
      config: {
        ...DEFAULT_EXTRACT_CONFIG,
        enabled: true,
        dwell: false,
        allowedPorts: new Set([80, 443, Number(new URL(origin).port)]),
      },
      assertAddress: async (hostname) => {
        screened.push(hostname);
        if (hostname === "metadata.internal") throw ExtractFailedError.blockedAddress();
      },
    });
    browsers.push(browser);

    // The whole reason the main document is followed one hop at a time: an
    // open redirect on an otherwise ordinary site would otherwise carry the
    // request somewhere the policy would never have allowed directly.
    const failure = await browser.render(`${origin}/open-redirect`, never).catch((err: unknown) => err);

    expect((failure as ExtractFailedError).kind).toBe("blocked_address");
    expect(screened).toContain("metadata.internal");
  });

  it("fails an oversized document, and measures it even when nothing declares a length", async () => {
    // Chunked on purpose: no content-length, which is exactly the shape that
    // used to sail past a header-based counter. A 6.9 MB JSON dump was
    // recorded as a successful read this way.
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html", "transfer-encoding": "chunked" });
      res.write("<html><body><p>");
      for (let chunk = 0; chunk < 8; chunk++) res.write("x".repeat(64 * 1024));
      res.end("</p></body></html>");
    });
    const origin = await listen(server);

    await expect(
      extractionBrowser(origin, { maxDocumentBytes: 128 * 1024 }).render(`${origin}/`, never),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("keeps a small document whose assets overrun the transfer budget", async () => {
    // The split this pins. One counter used to guard both concerns, so a
    // page died on the weight of its decoration: NYT, Bing and apple.com/docs
    // all failed on assets while their documents were under a megabyte.
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" }).end(
          `<html><body><h1>Small document</h1><p>The article itself is tiny.</p>
            <script src="/heavy.js"></script></body></html>`,
        );
        return;
      }
      const body = `/* ${"x".repeat(256 * 1024)} */`;
      res.writeHead(200, { "content-type": "text/javascript", "content-length": String(body.length) }).end(body);
    });
    const origin = await listen(server);

    const page = await extractionBrowser(origin, { maxBytes: 64 * 1024 }).render(`${origin}/`, never);

    // The content survives, and the render says why it may be missing assets
    // — the half of the outcome an operator needs when a page comes out thin.
    expect(page.html).toContain("The article itself is tiny.");
    expect(page.degradedBy).toBe("bytes");
  });

  it("still delivers a document already fetched when its own weight trips the budget", async () => {
    // A config no operator can write — loadConfig() clamps the document cap
    // to the transfer budget — but one a caller building an
    // ExtractConfig by hand can, which is what every test in this file does.
    //
    // The document is fetched whole in #resolveChain before either bound can
    // trip, so aborting the navigation that was about to be fulfilled from it
    // buys nothing and loses the read: the page comes back as one that could
    // not be loaded, having loaded perfectly.
    const body = `<html><body><p>${"x".repeat(400 * 1024)}</p></body></html>`;
    const origin = await serve({ "/": { body } });

    const page = await extractionBrowser(origin, {
      maxBytes: 300 * 1024,
      maxDocumentBytes: 4 * 1024 * 1024,
    }).render(`${origin}/`, never);

    expect(page.html).toContain("xxx");
    expect(page.degradedBy).toBe("bytes");
  });

  it("reports a clean render as not degraded at all", async () => {
    const origin = await serve({ "/": { body: "<html><body><p>Nothing was cut off.</p></body></html>" } });

    expect((await extractionBrowser(origin).render(`${origin}/`, never)).degradedBy).toBeUndefined();
  });

  it("reports status and content type from the final page-initiated document", async () => {
    const origin = await serve({
      "/": { body: `<html><body><script>location.href='/denied'</script></body></html>` },
      "/denied": { body: "access denied", status: 403, type: "text/plain; charset=utf-8" },
    });

    const page = await extractionBrowser(origin, { settleTimeoutMs: 200 }).render(`${origin}/`, never);

    expect(page.finalUrl).toBe(`${origin}/denied`);
    expect(page.status).toBe(403);
    expect(page.contentType).toBe("text/plain");
  });

  it("applies the document cap to a navigation the page starts for itself", async () => {
    // Otherwise the bound holds only for the URL the caller named, and one
    // meta-refresh is enough to walk around it.
    const big = `<html><body><p>${"x".repeat(256 * 1024)}</p></body></html>`;
    const origin = await serve({
      "/": { body: `<html><head><meta http-equiv="refresh" content="0;url=/big"></head><body>small</body></html>` },
      "/big": { body: big },
    });

    await expect(
      extractionBrowser(origin, { maxDocumentBytes: 64 * 1024, settleTimeoutMs: 500 }).render(`${origin}/`, never),
    ).rejects.toMatchObject({ kind: "too_large" });
  });

  it("reports a navigation that never arrives as a navigation failure", async () => {
    const server = createServer(() => {
      // Accepts the connection and answers nothing.
    });
    const origin = await listen(server);
    const browser = extractionBrowser(origin, { navigationTimeoutMs: 300 });

    const failure = await browser.render(`${origin}/`, never).catch((err: unknown) => err);
    expect((failure as ExtractFailedError).kind).toBe("navigation_failed");
    expect((failure as ExtractFailedError).message).toBe("That page could not be loaded.");
  });

  it("turns a refused address into a blocked failure, not a navigation error", async () => {
    const origin = await serve({ "/": { body: "<html><body>private</body></html>" } });
    const browser = new ExtractionBrowser({
      config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true, dwell: false },
      assertAddress: () => Promise.reject(ExtractFailedError.blockedAddress()),
    });
    browsers.push(browser);

    // Chromium reports a routed-away navigation as ERR_BLOCKED_BY_CLIENT,
    // which on its own is indistinguishable from an ad blocker. The renderer
    // has to remember it was the one that refused.
    const failure = await browser.render(`${origin}/`, never).catch((err: unknown) => err);
    expect((failure as ExtractFailedError).kind).toBe("blocked_address");
    expect((failure as ExtractFailedError).message).toBe("That URL could not be fetched.");
  });

  it("still applies the real policy by default", async () => {
    const origin = await serve({ "/": { body: "<html><body>loopback</body></html>" } });
    const browser = new ExtractionBrowser({ config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true, dwell: false } });
    browsers.push(browser);

    // No seam injected: a loopback origin must be refused outright.
    const failure = await browser.render(`${origin}/`, never).catch((err: unknown) => err);
    expect((failure as ExtractFailedError).kind).toBe("blocked_address");
  });

  it("abandons a render whose extraction was cancelled", async () => {
    const origin = await serve({ "/": { body: "<html><body>slow</body></html>" } });
    const controller = new AbortController();
    const browser = extractionBrowser(origin, { settleTimeoutMs: 5_000 });

    const rendering = browser.render(`${origin}/`, controller.signal);
    setTimeout(() => controller.abort(), 100);

    await expect(rendering).rejects.toBeInstanceOf(ExtractFailedError);
  });

  it("refuses further work once closed", async () => {
    const browser = new ExtractionBrowser({ config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true } });
    await browser.close();

    await expect(browser.render("https://example.com/", never)).rejects.toThrow(/shutting down/);
  });
});
