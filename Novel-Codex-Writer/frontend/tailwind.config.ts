import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ],
        serif: [
          "Noto Serif SC",
          "Source Han Serif SC",
          "Songti SC",
          "SimSun",
          "serif"
        ]
      },
      colors: {
        ink: "#161615",
        paper: "#f8f7f3",
        line: "#dedbd2",
        jade: "#0f766e",
        cinnabar: "#b42318",
        gold: "#b7791f"
      }
    }
  },
  plugins: [typography]
} satisfies Config;
