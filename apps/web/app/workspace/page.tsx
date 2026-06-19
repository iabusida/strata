import Link from "next/link";

export default function WorkspaceHomePage() {
  return (
    <main className="shell">
      <section className="panel">
        <h2>User Workspace</h2>
        <p className="section-collapsed-note">
          Account, trading style, and per-user simulation controls are grouped here so each user can run independent configurations.
        </p>
        <div className="settings-grid">
          <Link className="app-nav-link app-nav-link-active" href="/workspace/account">Account & Profile</Link>
          <Link className="app-nav-link app-nav-link-active" href="/workspace/trading-style">Trading Style Policies</Link>
          <Link className="app-nav-link app-nav-link-active" href="/workspace/simulation">Simulation Balance Config</Link>
        </div>
      </section>
    </main>
  );
}
