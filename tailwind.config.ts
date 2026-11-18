import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0C0F",
        panel: "#111419",
        "panel-strong": "#15181E",
        edge: "#232830",
        // Muted enough to read as cartography rather than neon signage.
        safe: "#7FBFA8",
        fast: "#D4715B",
        warn: "#C9A227",
        haven: "#9AD6C0",
        muted: "#8A93A0",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "sans-serif",
        ],
      },
      letterSpacing: {
        label: "0.09em",
      },
      borderRadius: {
        card: "10px",
      },
    },
  },
  plugins: [],
};

export default config;
