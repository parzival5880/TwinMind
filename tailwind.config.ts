import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        bg2: "var(--bg2)",
        bg3: "var(--bg3)",
        surface: "var(--surface)",
        surface2: "var(--surface2)",
        border: "var(--border)",
        border2: "var(--border2)",
        violet: "var(--violet)",
        "violet-dim": "var(--violet-dim)",
        amber: "var(--amber)",
        rose: "var(--rose)",
        teal: "var(--teal)",
        text: "var(--text)",
        "text-mid": "var(--text-mid)",
        "text-dim": "var(--text-dim)",
      },
      fontFamily: {
        sans: ["var(--font-plus-jakarta-sans)", "sans-serif"],
        mono: ["var(--font-jetbrains-mono)", "monospace"],
      },
    },
  },
};

export default config;
