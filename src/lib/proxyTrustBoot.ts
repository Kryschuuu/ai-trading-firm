/** ASA-08: Next.js liefert keinen Socket-Peer — kein CIDR-only-Betrieb. */
import { ConfigurationError } from "../auth/authMode";
import { resolveTrustedProxies, trustedProxySecret } from "./clientIp";

export function assertProxyTrustConfigured(
  env: Record<string, string | undefined> = process.env
): void {
  if (env.NEXT_PHASE === "phase-production-build") return;
  if (!resolveTrustedProxies(env).configured) return;
  if (trustedProxySecret(env) !== null) return;
  const missing = !(env.TRUSTED_PROXY_SECRET ?? "").trim();
  throw new ConfigurationError(
    "Refuse startup: TRUSTED_PROXY_IPS requires a valid TRUSTED_PROXY_SECRET " +
      "for Next.js Fetch requests (ASA-08); HOSTNAME is not proof of loopback binding.",
    missing ? "TRUSTED_PROXY_SECRET_REQUIRED" : "TRUSTED_PROXY_SECRET_INVALID",
    "Separat openssl rand -hex 32 erzeugen, als TRUSTED_PROXY_SECRET und im Proxy " +
      "als ueberschreibenden X-Proxy-Secret setzen (32–256 ASCII-Zeichen ohne " +
      "Leerzeichen/Komma). Alternativ TRUSTED_PROXY_IPS entfernen: gemeinsamer local-Bucket."
  );
}
