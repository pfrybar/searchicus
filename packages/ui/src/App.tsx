import { useEffect, useState } from "react";
import "./App.css";
import logoDark from "./assets/searchicus-logo-dark.png";
import logo from "./assets/searchicus-logo.png";
import { fetchCapabilities, type Capabilities } from "./api";
import { MetricsPage } from "./pages/MetricsPage";
import { SearchDetailPage } from "./pages/SearchDetailPage";
import { SearchPage } from "./pages/SearchPage";
import { SearchesPage } from "./pages/SearchesPage";
import { href, useHashRoute, type Route } from "./router";

export function App() {
  const route = useHashRoute();
  const [capabilities, setCapabilities] = useState<Capabilities>({ insights: false });

  useEffect(() => {
    // One read for the dashboard question, here rather than in each page: a
    // nav link to a page that can only answer 503 is worse than no link.
    fetchCapabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities({ insights: false }));
  }, []);

  const wide = route.name !== "search";

  return (
    <main className={wide ? "page wide" : "page"}>
      <header className="masthead">
        <div className="masthead-brand">
          <a className="brand" href={href({ name: "search" })}>
            {/* The wordmark is the image, so the heading it stands in for is
                read rather than seen, and the image itself is decorative. The
                dark variant differs only in the wordmark: its navy would sit
                almost invisibly on a dark background. */}
            <h1 className="visually-hidden">searchicus</h1>
            <picture>
              <source media="(prefers-color-scheme: dark)" srcSet={logoDark} />
              <img className="brand-logo" src={logo} alt="" width={600} height={117} />
            </picture>
          </a>
          <p className="tagline">One query, every backend search engine.</p>
        </div>
        {/* One section is not a nav: without the dashboard there is nowhere
            to go, and a lone pill marking the page you are already on is a
            control that does nothing. */}
        {capabilities.insights && (
          <nav aria-label="Sections">
            <NavLink route={{ name: "search" }} current={route} label="Search" />
            <NavLink route={{ name: "metrics" }} current={route} label="Metrics" />
            <NavLink route={{ name: "searches" }} current={route} label="History" />
          </nav>
        )}
      </header>

      {renderRoute(route)}
    </main>
  );
}

function renderRoute(route: Route) {
  switch (route.name) {
    case "metrics":
      return <MetricsPage />;
    case "searches":
      return <SearchesPage />;
    case "search-detail":
      return <SearchDetailPage searchId={route.searchId} />;
    default:
      return <SearchPage urlQuery={route.query ?? ""} />;
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
