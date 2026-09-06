import { useEffect, useState } from "react";
import "./App.css";
import { fetchCapabilities, type Capabilities } from "./api";
import { MetricsPage } from "./pages/MetricsPage";
import { SearchDetailPage } from "./pages/SearchDetailPage";
import { SearchPage } from "./pages/SearchPage";
import { SearchesPage } from "./pages/SearchesPage";
import { href, useHashRoute, type Route } from "./router";

export function App() {
  const route = useHashRoute();
  const [capabilities, setCapabilities] = useState<Capabilities>({ extract: false, insights: false });

  useEffect(() => {
    // One read for both questions, here rather than in each page: a nav link
    // to a page that can only answer 503, like an Extract button that can
    // only answer the same, is worse than no link at all.
    fetchCapabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities({ extract: false, insights: false }));
  }, []);

  const wide = route.name !== "search";

  return (
    <main className={wide ? "page wide" : "page"}>
      <header className="masthead">
        <div>
          <h1>searchicus</h1>
          <p className="tagline">One query, every backend search engine.</p>
        </div>
        <nav aria-label="Sections">
          <NavLink route={{ name: "search" }} current={route} label="Search" />
          {capabilities.insights && (
            <>
              <NavLink route={{ name: "metrics" }} current={route} label="Metrics" />
              <NavLink route={{ name: "searches" }} current={route} label="History" />
            </>
          )}
        </nav>
      </header>

      {renderRoute(route, capabilities)}
    </main>
  );
}

function renderRoute(route: Route, capabilities: Capabilities) {
  switch (route.name) {
    case "metrics":
      return <MetricsPage />;
    case "searches":
      return <SearchesPage />;
    case "search-detail":
      return <SearchDetailPage searchId={route.searchId} />;
    default:
      return <SearchPage canRead={capabilities.extract} />;
  }
}

function NavLink({ route, current, label }: { route: Route; current: Route; label: string }) {
  // The detail page belongs to History, so the section stays marked while
  // you are inside it.
  const active = current.name === route.name || (route.name === "searches" && current.name === "search-detail");

  return (
    <a href={href(route)} className={active ? "nav active" : "nav"} aria-current={active ? "page" : undefined}>
      {label}
    </a>
  );
}
