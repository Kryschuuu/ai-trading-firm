"use client";

import { useEffect, useState } from "react";

type ThemeId = "dark" | "light" | "sepia" | "midnight" | "nord" | "forest";

const THEMES: { id: ThemeId; label: string; hint: string }[] = [
  { id: "dark", label: "Dark", hint: "Slate – Standard, OLED-freundlich" },
  { id: "light", label: "Light", hint: "Hell – für helle Büros / Tageslicht" },
  { id: "sepia", label: "Sepia", hint: "Warmes Papier, weniger Blaulicht" },
  { id: "midnight", label: "Midnight", hint: "Tiefes Blauschwarz, minimaler Glare" },
  { id: "nord", label: "Nord", hint: "Arktis-Palette, weicher Kontrast" },
  { id: "forest", label: "Forest", hint: "Grün getönt, beruhigend" },
];

const STORAGE_KEY = "atf-theme";
const VALID: ThemeId[] = THEMES.map((t) => t.id);

function applyTheme(theme: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage ggf. gesperrt – ignorieren */
  }
}

export default function ThemeSwitcher() {
  // Server und erster Client-Render zeigen "dark"; das Inline-Script in
  // layout.tsx hat data-theme bereits gesetzt, wir gleichen hier nur den
  // Select-State an, um Hydration-Mismatches zu vermeiden.
  const [theme, setTheme] = useState<ThemeId>("dark");

  // Synchronisiere den Select-State mit dem bereits vom Inline-Script
  // gesetzten Theme. Async via setTimeout, um synchrones setState im
  // Effekt zu vermeiden (react-hooks/set-state-in-effect).
  useEffect(() => {
    const id = window.setTimeout(() => {
      const current = document.documentElement.getAttribute("data-theme") as ThemeId | null;
      if (current && VALID.includes(current)) setTheme(current);
    }, 0);
    return () => window.clearTimeout(id);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value as ThemeId;
    setTheme(next);
    applyTheme(next);
  }

  const active = THEMES.find((t) => t.id === theme);

  return (
    <label
      title={active?.hint ?? ""}
      className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
    >
      <span aria-hidden="true">🎨</span>
      <select
        value={theme}
        onChange={onChange}
        aria-label="Farbschema wählen"
        className="cursor-pointer bg-transparent pr-1 text-slate-100 outline-none"
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id} className="bg-slate-800 text-slate-100">
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}
