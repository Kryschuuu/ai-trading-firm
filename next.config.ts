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
