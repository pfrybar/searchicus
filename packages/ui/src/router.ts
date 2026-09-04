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
  { name: "search" } | { name: "metrics" } | { name: "searches" } | { name: "search-detail"; searchId: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "metrics") return { name: "metrics" };
  if (path === "searches") return { name: "searches" };

  const detail = /^searches\/(.+)$/.exec(path);
  if (detail?.[1]) return { name: "search-detail", searchId: decodeURIComponent(detail[1]) };

  return { name: "search" };
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
      return "#/";
  }
}
