import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./contexts/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        strata: {
          "bg-primary": "#020617",
          "bg-secondary": "#030B1A",
          "bg-surface": "#0B1220",
          "bg-card": "#0F172A",
          "text-primary": "#E6EDF3",
          "text-secondary": "#9FB3C8",
          "text-muted": "#6B859E",
          "accent-blue": "#2F7BFF",
          "accent-cyan": "#3EC6FF",
          "signal-ready": "#22C55E",
          "signal-caution": "#F59E0B",
          "signal-blocked": "#EF4444",
          "signal-building": "#38BDF8",
          "border-soft": "rgba(255,255,255,0.06)",
          "border-strong": "rgba(255,255,255,0.12)",
        },
      },
      boxShadow: {
        "strata-card": "inset 0 1px 0 rgba(255,255,255,0.06), 0 18px 40px rgba(2,6,23,0.55)",
      },
      borderRadius: {
        "strata": "14px",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
