import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

import { sendPasswordResetEmail, sendVerificationEmail } from "./emailService";

const senders = [
  {
    name: "verification",
    send: sendVerificationEmail,
    link: "https://app.test/verify-email?token=tok123",
  },
  {
    name: "password reset",
    send: sendPasswordResetEmail,
    link: "https://app.test/reset-password?token=tok123",
  },
];

beforeEach(() => {
  sendMail.mockReset();
  sendMail.mockResolvedValue({});
  vi.stubEnv("BETTER_AUTH_URL", "https://app.test");
  vi.stubEnv("EMAIL_USER", "sender@app.test");
});

describe.each(senders)("$name email", ({ send, link }) => {
  it("links to the configured BETTER_AUTH_URL", async () => {
    await send("user@example.com", "tok123", "Sam");

    expect(sendMail.mock.lastCall?.[0].html).toContain(`href="${link}"`);
  });

  it("refuses to send a link when BETTER_AUTH_URL is not set", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "");

    await expect(send("user@example.com", "tok123", "Sam")).rejects.toThrow(
      "BETTER_AUTH_URL",
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("escapes the user's name", async () => {
    await send("user@example.com", "tok123", '<img src=x onerror="a()">');

    const html = sendMail.mock.lastCall?.[0].html;
    expect(html).not.toContain("<img");
    expect(html).toContain(
      "Hi &lt;img src=x onerror=&quot;a()&quot;&gt;,",
    );
  });

  it("rejects when the mail server fails", async () => {
    sendMail.mockRejectedValue(new Error("smtp down"));

    await expect(send("user@example.com", "tok123", "Sam")).rejects.toThrow(
      "smtp down",
    );
  });
});
