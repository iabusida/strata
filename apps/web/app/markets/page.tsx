import Link from "next/link";

export default function MarketsHubPage() {
  return (
    <main className="shell">
      <section className="panel">
        <h2>Markets Workspace</h2>
        <p className="section-collapsed-note">
          Choose a market domain. This structure keeps crypto, stocks, and forecast workflows isolated as the product scales.
        </p>
        <div className="settings-grid">
          <Link className="app-nav-link app-nav-link-active" href="/markets/crypto">Crypto Market Intelligence</Link>
          <Link className="app-nav-link app-nav-link-active" href="/markets/stocks">Stock Market Intelligence</Link>
          <Link className="app-nav-link app-nav-link-active" href="/markets/forecast">Momentum Forecasts</Link>
        </div>
      </section>
    </main>
  );
}
