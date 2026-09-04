import {
  DEFAULT_EXTRACT_CONFIG,
  ExtractionService,
  type ExtractConfig,
  type PageRenderer,
  type RenderedPage,
} from "@searchicus/core";

/** Renders a fixed page without a browser, so adapter tests need no Chromium. */
class StubRenderer implements PageRenderer {
  constructor(private readonly behavior: () => Promise<RenderedPage> = async () => STUB_PAGE) {}

  async render(): Promise<RenderedPage> {
    return this.behavior();
  }

  async close(): Promise<void> {}
}

const STUB_PAGE: RenderedPage = {
  finalUrl: "https://example.test/article",
  html: "<html></html>",
  status: 200,
  redirects: 0,
};

/**
 * An extraction service that always succeeds, for exercising the front doors
 * rather than the renderer. Pass `enabled: false` for the default-off case.
 */
export function testExtraction(overrides: Partial<ExtractConfig> = {}, renderer?: PageRenderer): ExtractionService {
  return new ExtractionService({
    config: { ...DEFAULT_EXTRACT_CONFIG, enabled: true, ...overrides },
    renderer: renderer ?? new StubRenderer(),
    parse: async () => ({
      title: "An article",
      markdown: "# An article\n\nSome readable prose.",
      wordCount: 4,
    }),
    lookup: async () => ["93.184.216.34"],
  });
}
