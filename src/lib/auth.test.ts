import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, store } = vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = "https://app.test";
  process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-test-secret-1234";
  process.env.EMAIL_USER = "sender@app.test";
  return {
    sendMail: vi.fn(),
    store: {
      user: [],
      session: [],
      account: [],
      verification: [],
    } as Record<string, Record<string, unknown>[]>,
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));
vi.mock("@/lib/db/client", () => ({ db: {} }));
vi.mock("better-auth/adapters/drizzle", async () => {
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  return { drizzleAdapter: () => memoryAdapter(store) };
});

import { auth } from "./auth";

const PASSWORD = "Original1pass";
const EMAIL = "new.user@example.com";

const call = (path: string, init?: { body?: unknown }) =>
  auth.handler(
    new Request(`https://app.test/api/auth${path}`, {
      method: init ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
      },
      body: init ? JSON.stringify(init.body) : undefined,
    }),
  );

const signUp = () =>
  call("/sign-up/email", {
    body: { email: EMAIL, password: PASSWORD, name: "New User" },
  });

const signIn = (password = PASSWORD) =>
  call("/sign-in/email", { body: { email: EMAIL, password } });

const lastEmailedToken = (page: string) => {
  const html: string = sendMail.mock.lastCall?.[0].html;
  const match = html.match(
    new RegExp(`href="https://app\\.test/${page}\\?token=([^"]+)"`),
  );
  if (!match) throw new Error(`no ${page} link in: ${html}`);
  return match[1];
};

beforeEach(() => {
  for (const table of Object.values(store)) table.length = 0;
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
});

describe("email verification flow", () => {
  it("signs the user in when they open the emailed link", async () => {
    await signUp();
    const token = lastEmailedToken("verify-email");

    const response = await call(
      `/verify-email?token=${encodeURIComponent(token)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session_token");
    expect((await signIn()).status).toBe(200);
  });

  it("emails a link that stays valid for 24 hours", async () => {
    await signUp();
    const payload = JSON.parse(
      Buffer.from(
        lastEmailedToken("verify-email").split(".")[1],
        "base64url",
      ).toString(),
    );

    expect(payload.exp - payload.iat).toBe(86400);
  });

  it("emails a fresh link when an unverified user tries to sign in", async () => {
    await signUp();
    sendMail.mockClear();

    const response = await signIn();

    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("EMAIL_NOT_VERIFIED");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.lastCall?.[0].to).toBe(EMAIL);
  });

  it("answers a resend the same way for a known and unknown address when sending fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await signUp();
    sendMail.mockRejectedValue(new Error("smtp down"));

    const known = await call("/send-verification-email", {
      body: { email: EMAIL },
    });
    const unknown = await call("/send-verification-email", {
      body: { email: "nobody@example.com" },
    });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("password reset flow", () => {
  const requestReset = (email: string) =>
    call("/request-password-reset", { body: { email } });

  const verifiedUser = async () => {
    await signUp();
    await call(
      `/verify-email?token=${encodeURIComponent(lastEmailedToken("verify-email"))}`,
    );
    sendMail.mockClear();
  };

  it("emails a link whose token changes the password", async () => {
    await verifiedUser();

    await requestReset(EMAIL);
    const token = lastEmailedToken("reset-password");
    const response = await call("/reset-password", {
      body: { token, newPassword: "Changed2pass" },
    });

    expect(response.status).toBe(200);
    expect((await signIn(PASSWORD)).status).toBe(401);
    expect((await signIn("Changed2pass")).status).toBe(200);
  });

  it("does not write the reset token to the logs", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await verifiedUser();
    log.mockClear();

    await requestReset(EMAIL);

    const token = lastEmailedToken("reset-password");
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it("gives one answer for known, unknown and failed-send addresses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await verifiedUser();

    const sent = await requestReset(EMAIL);
    const unknown = await requestReset("nobody@example.com");
    sendMail.mockRejectedValue(new Error("smtp down"));
    const failed = await requestReset(EMAIL);

    const expected = {
      status: true,
      message:
        "If this email exists in our system, check your email for the reset link",
    };
    for (const response of [sent, unknown, failed]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
  });
});
