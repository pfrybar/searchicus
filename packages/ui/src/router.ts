import { useEffect, useState } from "react";

/**
 * The routes the UI knows about.
 *
 * Hash-based, deliberately. The API and the UI share one origin and one
 * Express app, so real paths would need a history fallback for non-API routes
 * — and `app.ts` already explains why a catch-all there is a trap: it turns
 * genuine API 404s into HTML. A hash keeps deep links working (a search
 * detail page can be pasted to someone) with no server change at all, which
 * for a local dashboard is the whole of what routing needs to do.
 */
export type Route =
  /** `query` is the `q` of `#/?q=…`: a search anyone can paste or reload into. */
  | { name: "search"; query?: string }
  | { name: "metrics" }
  | { name: "searches" }
  | { name: "search-detail"; searchId: string };

export function parseHash(hash: string): Route {
  // Split on the first `?` by index rather than String.split, which with a
  // limit would silently drop everything after a second one.
  const mark = hash.indexOf("?");
  const path = (mark === -1 ? hash : hash.slice(0, mark)).replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "metrics") return { name: "metrics" };
  if (path === "searches") return { name: "searches" };

  const detail = /^searches\/(.+)$/.exec(path);
  if (detail?.[1]) return { name: "search-detail", searchId: decodeSegment(detail[1]) };

  // URLSearchParams decodes leniently — a stray percent comes back as itself
  // rather than throwing, which is what decodeSegment below had to be taught.
  const query = mark === -1 ? null : new URLSearchParams(hash.slice(mark + 1)).get("q")?.trim();
  // Omitted rather than undefined when absent, so a bare `#/` is the same
  // route object it has always been.
  return query ? { name: "search", query } : { name: "search" };
}

/**
 * Decodes one path segment, surviving a hash nobody meant to type.
 *
 * `decodeURIComponent` throws on a stray percent or a truncated escape, and
 * this runs during the first render and on every hashchange — so a URL like
 * `#/searches/%` took the whole page down rather than showing "no such
 * search". The undecoded text is the better fallback: it will not resolve to
 * a search either, but it fails where the rest of the UI can explain itself.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Current route, kept in step with the address bar and the back button. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

/** The href for a route, so links and the parser cannot drift apart. */
export function href(route: Route): string {
  switch (route.name) {
    case "metrics":
      return "#/metrics";
    case "searches":
      return "#/searches";
    case "search-detail":
      return `#/searches/${encodeURIComponent(route.searchId)}`;
    default:
      // `q=my+query`, as a form-encoded parameter rather than a path segment:
      // a query is free text, and the path is where ids live.
      return route.query ? `#/?${new URLSearchParams({ q: route.query }).toString()}` : "#/";
  }
}
