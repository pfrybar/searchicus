import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContextOptions, LaunchOptions } from "playwright";
import type { PersistentContextOptions } from "./session.js";

const execFileAsync = promisify(execFile);

/**
 * Browser identity: context options plus one init script, chosen so the
 * story the page tells about itself has no internal contradictions.
 *
 * The guiding rule is that what gets noticed is *contradictions*, not
 * fields. A value that is unusual but consistent with every other value
 * costs far less than a plausible value that disagrees with its neighbours.
 * That is also why parts of this file are conspicuously empty — see the
 * "deliberately not patched" notes in STEALTH_INIT, where the patch would
 * stand out more than the tell it hides.
 *
 * The one residual this cannot fix is the worker-realm WebGL identity; see
 * the WebGL note at the bottom of STEALTH_INIT for why it is left alone.
 */

/** Viewport. Deliberately not a round automation default (1280x720 etc.). */
export const VIEWPORT = { width: 1520, height: 857 } as const;
/** Outer window: viewport plus title bar and tab strip. */
const OUTER = { width: 1520, height: 921 } as const;
/** A common laptop panel. Bigger than the window: an ordinary unmaximized state. */
const SCREEN = { width: 1920, height: 1080 } as const;

/**
 * Default IANA time zone.
 *
 * This must agree with the geolocation of the IP the traffic actually
 * leaves from: a detector that compares the two sees a contradiction, which
 * is the exact class of tell the rest of this file exists to avoid. There is
 * no way to derive it correctly at build time, so it is configurable and the
 * default matches this project's current egress. Set `browser.timezone` when
 * running from elsewhere.
 */
export const DEFAULT_TIMEZONE = "America/Chicago";
/** Default locale. Should likewise be plausible for the egress IP's country. */
export const DEFAULT_LOCALE = "en-US";

/**
 * Chromium major version used when the binary can't be interrogated.
 * Only ever a fallback — `resolveChromiumMajor()` reads the real one, and a
 * hardcoded major goes stale the moment Playwright is bumped.
 */
export const FALLBACK_CHROMIUM_MAJOR = "151";

/**
 * Launch arguments.
 *
 * `--disable-blink-features=AutomationControlled` turns `navigator.webdriver`
 * off *at the source* rather than patching the accessor in JS. That matters:
 * a redefined navigator accessor is itself a strong signal, and a stronger
 * one than the flag it would be hiding, so the JS "fix" is worse than the
 * tell. Verified: with this flag the raw binary reports
 * `navigator.webdriver === false` with nothing patched at all.
 *
 * `--no-sandbox` is deliberately absent. It is the usual reflex for running
 * Chromium in a container, but this project's container runs unprivileged
 * with `--shm-size=1g` precisely so the sandbox can stay on, and Chromium
 * was verified to launch here without it.
 */
export const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"];

export interface StealthOptions {
  /** Chromium major version, e.g. "151". Must match the actual binary. */
  major?: string;
  /** IANA time zone. Defaults to DEFAULT_TIMEZONE / SEARCHICUS_TIMEZONE. */
  timezoneId?: string;
  /** BCP-47 locale. Defaults to DEFAULT_LOCALE / SEARCHICUS_LOCALE. */
  locale?: string;
}

/**
 * Reads the Chromium major version out of the binary Playwright will launch.
 *
 * One `--version` call, no browser start. The alternative — hardcoding the
 * major — introduces a contradiction the moment Playwright is upgraded,
 * because the UA would then claim a version the binary doesn't have.
 * Falls back rather than throwing: a stale major is a weaker fingerprint,
 * but a browser that won't start is a broken product.
 */
export async function resolveChromiumMajor(executablePath: string): Promise<string> {
  try {
    // "Google Chrome for Testing 151.0.7922.34" -> "151"
    const { stdout } = await execFileAsync(executablePath, ["--version"]);
    return /(\d+)\./.exec(stdout)?.[1] ?? FALLBACK_CHROMIUM_MAJOR;
  } catch {
    // An unreadable binary is about to fail at launch anyway, with a much
    // better error than anything this function could throw.
    return FALLBACK_CHROMIUM_MAJOR;
  }
}

/**
 * The user agent, with `HeadlessChrome` replaced by `Chrome`.
 *
 * This is the *only* identity string that gets overridden, and it has to be:
 * even the full Chromium binary in new-headless mode reports
 * `HeadlessChrome/151.0.0.0`, which announces the automation in the plainest
 * possible terms before anything else is examined. Everything else is left
 * to the browser.
 *
 * Note `Chrome/<major>.0.0.0` is exactly the form real Chromium uses too;
 * the "Chrome" product token is not a Google-Chrome-only thing.
 */
export function buildUserAgent(major: string): string {
  return (
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` + `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

/**
 * Context + launch options for a fingerprint-consistent browser.
 *
 * **Client Hints are deliberately not set.** Hand-writing a `sec-ch-ua`
 * triplet is the tempting move here, and it is a trap: the values are easy
 * to copy from a real Chrome, and wrong for the binary this actually runs.
 * Real `navigator.userAgentData.brands` here is
 * `[Chromium 151, Not=A?Brand 99]` — two brands rather than three, a
 * different GREASE token, and no "Google Chrome" entry at all. A fabricated
 * header would disagree with the JS API, and
 * `getHighEntropyValues().fullVersionList` would contradict it again.
 * Letting Chromium send its own hints is self-consistent by construction,
 * cannot drift when Playwright is bumped, measures no worse, and has no
 * maintenance surface.
 *
 * `channel: "chromium"` is load-bearing, and is the single highest-leverage
 * setting in this file. Playwright's default headless is
 * `chrome-headless-shell`, which is a *different binary*: it has no
 * `window.chrome`, an empty plugin list, no media devices and no WebGPU
 * adapter. Those are not things an init script can convincingly add — they
 * are absences a real browser does not have. The full binary in new-headless
 * mode has all of them for free.
 */
export function buildStealthOptions(options: StealthOptions = {}): PersistentContextOptions {
  const major = options.major ?? FALLBACK_CHROMIUM_MAJOR;

  return {
    headless: true,
    channel: "chromium",
    args: LAUNCH_ARGS,
    userAgent: buildUserAgent(major),
    viewport: { ...VIEWPORT },
    deviceScaleFactor: 1,
    locale: options.locale ?? DEFAULT_LOCALE,
    timezoneId: options.timezoneId ?? DEFAULT_TIMEZONE,
    colorScheme: "light",
    // A browser that has been used has granted the common permissions;
    // the headless default is a different, detectable state. clipboard-read
    // is deliberately excluded — real users rarely grant it, so a granted
    // state would itself look anomalous against the Permissions API.
    permissions: ["notifications", "geolocation"],
  };
}

/**
 * Geometry and minor property consistency, injected into every document
 * before page scripts run.
 *
 * Values are fixed for the life of the context, which is the honest model:
 * one person's setup does not change between tabs. (The reference
 * implementation created a context per task and claimed "a fresh fingerprint
 * every navigation", but every value in it was a hardcoded constant — so it
 * never was fresh. Under this project's single long-lived context those
 * constants finally mean what they say.)
 *
 * Built from the geometry constants above rather than repeating them, so the
 * viewport option and the JS-visible geometry cannot drift apart.
 */
export const STEALTH_INIT = `
// ---- window / screen geometry (headless has outer===inner, screen===viewport) ----
const IN = [${VIEWPORT.width}, ${VIEWPORT.height}];
const OUT = [${OUTER.width}, ${OUTER.height}];
const SCREEN = [${SCREEN.width}, ${SCREEN.height}];
const def = (o, k, v) => {
  try {
    Object.defineProperty(o, k, {
      get: () => v, configurable: false,
    });
  } catch (e) {}
};
def(window, "innerWidth", IN[0]);
def(window, "innerHeight", IN[1]);
def(window, "outerWidth", OUT[0]);
def(window, "outerHeight", OUT[1]);
def(window, "screenX", 14);
def(window, "screenY", 34);
try {
  const sc = {};
  def(sc, "width", SCREEN[0]);
  def(sc, "height", SCREEN[1]);
  def(sc, "availWidth", SCREEN[0]);
  def(sc, "availHeight", SCREEN[1] - 40);   // taskbar
  def(sc, "colorDepth", 24);
  def(sc, "pixelDepth", 24);
  def(sc, "availLeft", 0);
  def(sc, "availTop", 0);
  Object.defineProperty(window, "screen", { get: () => sc, configurable: false });
} catch (e) {}

// ---- navigator: deliberately LEFT NATIVE. ----
// Redefining any navigator accessor as a data property or a non-native getter
// (webdriver / hardwareConcurrency / languages / plugins) is trivially
// detectable and is a far stronger signal than any value it could hide. The
// raw values from the full Chromium binary are already plausible on their
// own, and --disable-blink-features=AutomationControlled already makes
// navigator.webdriver false, so we must NOT redefine
// navigator.hardwareConcurrency / deviceMemory / languages / pdfViewerEnabled.

// ---- media devices: headless ships with zero audio/video endpoints, which
//      no ordinary desktop does — a real one exposes at least a default mic
//      and speaker, plus a webcam on a laptop. Synthesize that set only when
//      the platform has none. This patches the enumerateDevices method on the
//      mediaDevices object, not a navigator-prototype accessor, so it does not
//      run into the native-accessor problem described above. Labels stay
//      empty, exactly as they are before permission is granted.
try {
  const md = navigator.mediaDevices;
  if (md && typeof md.enumerateDevices === "function") {
    const origEnum = md.enumerateDevices.bind(md);
    md.enumerateDevices = function () {
      return origEnum().then(function (list) {
        if (list && list.length > 0) return list;
        return [
          { deviceId: "a1", kind: "audioinput", label: "", groupId: "g1" },
          { deviceId: "a2", kind: "audiooutput", label: "", groupId: "g1" },
          { deviceId: "v1", kind: "videoinput", label: "", groupId: "g1" },
        ];
      });
    };
  }
} catch (e) {}

// ---- WebGPU: a software/headless build either lacks WebGPU entirely or
//      returns a null adapter, where a real desktop GPU adapter reports
//      support for the shader-f16 feature. Fake the adapter only when the
//      real one is null or missing that feature; otherwise pass through.
//      Patches gpu.requestAdapter only (an own property of the navigator.gpu
//      object), so it does not run into the native-accessor problem above.
try {
  const gpu = navigator.gpu;
  if (gpu && typeof gpu.requestAdapter === "function") {
    const origRA = gpu.requestAdapter.bind(gpu);
    const makeFake = function (adapter) {
      const f16 = adapter ? adapter.features.has("shader-f16") : false;
      const features = new Set(f16
        ? [...adapter.features, "shader-f16"]
        : ["depth-clip-clamp", "float32-blend", "shader-f16"]);
      return {
        features: features,
        limits: {
          maxTextureDimension2D: 16384, maxTextureDimension3D: 2048,
          maxTextureArrayLayers: 2048, maxBufferSize: 268435456,
          maxBindGroups: 8, maxBindGroupsPerStage: 8,
          maxBindingsPerBindGroup: 1000, maxDynamicUniformBuffersPerDrawCall: 256,
          maxDynamicStorageBuffersPerDrawCall: 256,
          maxColorAttachmentBytesPerPixel: 8,
          maxComputeWorkGroupCountX: 256, maxComputeWorkGroupCountY: 256,
          maxComputeWorkGroupCountZ: 64, maxComputeInvocationsPerWorkgroup: 256,
          maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64,
          maxStorageBufferBindingSize: 268435456,
          maxUniformBufferBindingSize: 65536,
          maxVertexBuffers: 8,
          maxBufferSizeDynamicOffsetAlignment: 256,
          maxStorageTextureBindings: 128, maxSamplerBindings: 16,
          maxColorAttachments: 8,
          maxComputeStorageTextureBindingsNonImage: 128,
          maxComputeWorkgroupSizeTotal: 256,
          maxNonSampledTextures: 128,
          maxSampledTexturesPerShader: 128,
          maxSamplersPerShader: 16,
          maxColorAttachmentsPerShader: 8,
        },
        getInfo: function () {
          return {
            architecture: "vulkan", vendor: "intel", device: "uhd-630", description: "Intel(R) UHD Graphics 630",
          };
        },
        requestAdapter: undefined,
        requestDevice: function () {
          return Promise.reject(new DOMException("WebGPU device is not available in this fake adapter", "NotSupportedError"));
        },
        destroy: function () {
          if (adapter) adapter.destroy();
        },
      };
    };
    gpu.requestAdapter = function (opts) {
      return origRA(opts).then(function (adapter) {
        if (adapter && adapter.features.has("shader-f16")) return adapter;
        // null adapter (software/headless container) or a real adapter
        // missing shader-f16: replace with the desktop-shaped fake.
        return makeFake(adapter);
      });
    };
  }
} catch (e) {}

// ---- expose the live cursor position for the interaction helpers ----
// (humanWander tracks where the hand is so it can drift relatively instead
//  of teleporting)
window.__mouseX = -1;
window.__mouseY = -1;
window.addEventListener("mousemove", (e) => {
  window.__mouseX = e.clientX;
  window.__mouseY = e.clientY;
}, { passive: true });

// ---- WebGL: bare headless names a software rasterizer (SwiftShader or
//      llvmpipe) as its renderer, which no ordinary desktop does. Pin a
//      plausible Linux-Intel pair instead. Note the pixel hashes stay
//      software-rendered: the strings are pinned, the rasterizer is not. ----
try {
  const glp = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return "Google Inc. (Intel)";
    if (p === 37446) return "MESA Intel(R) UHD Graphics 630";
    return glp.call(this, p);
  };
  const webgl2p = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (p) {
    if (p === 37445) return "Google Inc. (Intel)";
    if (p === 37446) return "MESA Intel(R) UHD Graphics 630";
    return webgl2p.call(this, p);
  };
  // OffscreenCanvas: deliberately NOT patched. Its getContext has a
  // brand-check on the canvas object: a wrapper that re-invokes the
  // original with a prototype as \`this\` throws Illegal invocation in the
  // page realm and breaks every 2D-canvas consumer. The worker-realm
  // offscreen canvas gets a fresh WebGL context that an init script cannot
  // reach at all, because workers get their own JS realm. So a page that
  // compares the two sees the patched identity here and the raw software
  // one in a worker: a known, unavoidable residual. Accepting it is still
  // the cheaper trade, because dropping the patch above would instead
  // advertise a software rasterizer to *everything* that looks.
} catch (e) {}
`;

/**
 * The same identity, split for a browser that has no persistent profile.
 *
 * `launchPersistentContext` takes launch and context options as one object;
 * `chromium.launch()` plus `browser.newContext()` take them separately. Both
 * halves are derived from the constants above rather than restated, so the
 * search browser and the extraction browser cannot drift into telling
 * different stories about the same machine.
 */
export function buildStealthBrowserOptions(options: StealthOptions = {}): {
  launch: LaunchOptions;
  context: BrowserContextOptions;
} {
  const { headless, channel, args, ...context } = buildStealthOptions(options);
  return { launch: { headless, channel, args }, context };
}
