import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getTrustedOrigins } from "@/lib/auth-origins";
import { db } from "@/lib/db/client";
import { sendVerificationEmail } from "@/lib/services/emailService";

export const auth = betterAuth({
  appName: "LegalyzeAI",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // update every 24h
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  user: {
    additionalFields: {
      dailyUploadCount: {
        type: "number",
        defaultValue: 0,
      },
      lastUploadDate: {
        type: "date",
      },
    },
  },
  trustedOrigins: getTrustedOrigins(process.env.VERCEL_URL),
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
      allowDifferentEmails: false,
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, token }) => {
      await sendVerificationEmail(user.email, token, user.name || "User");
    },
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      console.log(`Password reset link for ${user.email}: ${url}`);
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
});
