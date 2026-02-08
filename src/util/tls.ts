import crypto from "node:crypto";
import tls from "node:tls";

export function normalizeFingerprint(input: string): string {
  return input.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
}

export function parseFingerprints(input?: string): string[] {
  if (!input) return [];
  return input
    .split(",")
    .map((entry) => normalizeFingerprint(entry))
    .filter(Boolean);
}

export function buildCheckServerIdentity(
  expectedHost: string,
  fingerprints: string[]
): (host: string, cert: tls.PeerCertificate) => Error | undefined {
  return (host: string, cert: tls.PeerCertificate) => {
    if (host !== expectedHost) {
      return new Error(`Unexpected host: ${host}`);
    }

    const standard = tls.checkServerIdentity(host, cert);
    if (standard) return standard;

    if (!fingerprints.length) {
      return undefined;
    }

    const fingerprint = cert.fingerprint256
      ? normalizeFingerprint(cert.fingerprint256)
      : normalizeFingerprint(crypto.createHash("sha256").update(cert.raw).digest("hex"));

    if (!fingerprint) {
      return new Error("Unable to determine certificate fingerprint");
    }

    if (!fingerprints.includes(fingerprint)) {
      return new Error("Certificate fingerprint mismatch");
    }

    return undefined;
  };
}
