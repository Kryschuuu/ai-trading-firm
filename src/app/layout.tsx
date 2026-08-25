import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous AI Trading Firm — Local-First",
  description:
    "Open-source, local-first autonomous trading firm for Ollama + PostgreSQL on your own hardware. Paper trading only.",
};

// Setzt das Theme noch vor dem ersten Paint (kein Flackern), bevor React
// hydriert. Liest die Wahl aus localStorage, fällt auf "dark" zurück.
const themeBootstrap = `(function(){try{var t=localStorage.getItem("atf-theme");if(t!=="dark"&&t!=="light"&&t!=="sepia"&&t!=="midnight"&&t!=="nord"&&t!=="forest"){t="dark";}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-slate-950 text-slate-50 antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        {children}
      </body>
    </html>
  );
}
