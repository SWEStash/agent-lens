import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// Light/dark theming. The palette lives in CSS custom properties (styles.css), switched by a
// `data-theme` attribute on <html>; charts read those same vars via useChartTokens (charts/theme.tsx),
// so CSS is the single source of truth. Default is dark. The choice persists in localStorage, and an
// inline script in index.html applies it before first paint to avoid a flash.

export type Theme = "dark" | "light";
const KEY = "agentlens.theme";

function initialTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme; // set by the anti-FOUC inline script
    if (attr === "light" || attr === "dark") return attr;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s === "light" || s === "dark") return s;
  } catch {}
  return "dark";
}

const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  // Set the attribute during render (before children read computed styles) so useChartTokens sees
  // the new palette on the same pass; persistence is a side effect.
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme;
  useEffect(() => {
    try { localStorage.setItem(KEY, theme); } catch {}
  }, [theme]);
  const toggle = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
