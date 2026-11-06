import { betterAuth } from "better-auth";
import { describe, expect, it } from "vitest";
import { getTrustedOrigins } from "./auth-origins";

// `isTrustedOrigin` is the check better-auth runs on request origins and
// callback URLs; its underlying matcher is not exported from a public path.
async function trustCheck(vercelUrl?: string) {
  const auth = betterAuth({
    baseURL: "https://legalyze-ai.vercel.app",
    secret: "test-secret-at-least-32-characters-long",
    trustedOrigins: getTrustedOrigins(vercelUrl),
  });
  const context = await auth.$context;
  return (url: string) => context.isTrustedOrigin(url);
}

describe("getTrustedOrigins", () => {
  it("trusts production and localhost", async () => {
    const isTrusted = await trustCheck();

    expect(isTrusted("https://legalyze-ai.vercel.app")).toBe(true);
    expect(isTrusted("http://localhost:3000")).toBe(true);
  });

  it("rejects other vercel.app sites and lookalike hosts", async () => {
    const isTrusted = await trustCheck();

    expect(isTrusted("https://evil.vercel.app")).toBe(false);
    expect(isTrusted("https://evil.vercel.app/steal")).toBe(false);
    expect(isTrusted("https://legalyze-ai.vercel.app.evil.com")).toBe(false);
  });

  it("trusts only the current deployment's preview URL", async () => {
    const isTrusted = await trustCheck("legalyze-ai-abc123-team.vercel.app");

    expect(isTrusted("https://legalyze-ai-abc123-team.vercel.app")).toBe(true);
    expect(isTrusted("https://legalyze-ai-def456-team.vercel.app")).toBe(false);
    expect(isTrusted("https://evil.vercel.app")).toBe(false);
  });

  it("produces no wildcard patterns", () => {
    const origins = getTrustedOrigins("legalyze-ai-abc123-team.vercel.app");

    expect(origins.join()).not.toMatch(/[*?]/);
  });

  it("adds nothing when VERCEL_URL is unset or empty", () => {
    const productionAndLocal = [
      "http://localhost:3000",
      "https://legalyze-ai.vercel.app",
    ];

    expect(getTrustedOrigins(undefined)).toEqual(productionAndLocal);
    expect(getTrustedOrigins("")).toEqual(productionAndLocal);
  });
});
