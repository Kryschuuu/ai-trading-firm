import type { NextConfig } from "next";

/**
 * KORRIGIERT (v1.1.0): Security-Header in Produktion.
 *
 * Die App lebt lokal, aber das Dashboard läuft im Browser — ohne
 * X-Frame-Options/CSP kann eine fremde Seite die lokale UI einbetten
 * (Clickjacking) oder Inhalte exfiltrieren. Die CSP erlaubt nur Self-Content;
 * 'unsafe-inline' für Scripts/Styles ist bei Next.js (inline Bootstrap-Hydration)
 * erforderlich. Im Dev-Modus bleibt alles offen, damit HMR funktioniert.
 */
const nextConfig: NextConfig = {
  /**
   * Relative Markdown-Links aus `/docs` ohne trailing slash werden vom
   * Browser als `/ARCHITECTURE.md` aufgelöst. Die gerenderte Doku lebt unter
   * `/docs/<Datei>.md` — dieser Redirect macht die alten 404-URLs gültig.
   * Die Middleware (`src/middleware.ts`) macht dasselbe plus `?name=`-Slug.
   */
  async redirects() {
    return [
      { source: "/:file.md", destination: "/docs/:file.md", permanent: false },
      {
        source: "/audit-remediation/:file.md",
        destination: "/docs/audit-remediation/:file.md",
        permanent: false,
      },
    ];
  },
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
