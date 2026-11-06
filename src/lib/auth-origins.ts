export function getTrustedOrigins(vercelUrl: string | undefined): string[] {
  const origins = ["http://localhost:3000", "https://legalyze-ai.vercel.app"];
  return vercelUrl ? [...origins, `https://${vercelUrl}`] : origins;
}
