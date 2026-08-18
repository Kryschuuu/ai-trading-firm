import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Autonomous AI Trading Firm — Local-First",
  description:
    "Open-source, local-first autonomous trading firm for Ollama + PostgreSQL on your own hardware. Paper trading only.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
