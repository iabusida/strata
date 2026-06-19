"use client";

import { useState } from "react";

const STYLE_OPTIONS = ["LONG_TERM", "DAY_TRADING", "SWING", "SCALP"] as const;

export function WorkspaceAccountConsole() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [style, setStyle] = useState<(typeof STYLE_OPTIONS)[number]>("DAY_TRADING");
  const [message, setMessage] = useState<string | null>(null);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setMessage("Account scaffolding saved locally for UI flow. Backend auth endpoint can be wired next.");
  }

  return (
    <main className="shell">
      <section className="panel">
        <h2>Account & Trading Identity</h2>
        <p className="section-collapsed-note">
          Multi-user onboarding starts here: each user can define profile and default trading style before simulation or live execution setup.
        </p>

        <form className="settings-grid" onSubmit={handleSubmit}>
          <div className="settings-field">
            <label htmlFor="account-name">Full Name</label>
            <input id="account-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Trader" />
          </div>

          <div className="settings-field">
            <label htmlFor="account-email">Email</label>
            <input id="account-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@example.com" />
          </div>

          <div className="settings-field">
            <label htmlFor="default-style">Default Trading Style</label>
            <select id="default-style" value={style} onChange={(e) => setStyle(e.target.value as (typeof STYLE_OPTIONS)[number])}>
              {STYLE_OPTIONS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </div>

          <div className="settings-actions">
            <button type="submit" className="settings-toggle">Save Profile Scaffold</button>
          </div>
        </form>

        {message ? <p className="section-collapsed-note">{message}</p> : null}
      </section>
    </main>
  );
}
