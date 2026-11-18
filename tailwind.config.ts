import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0E0E10",
        panel: "#17171A",
        edge: "#2A2A2E",
        safe: "#4ADE80",
        fast: "#9CA3AF",
        alarm: "#D92D2D",
        warn: "#F59E0B",
        haven: "#4ADE80",
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
