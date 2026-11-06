// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { signInEmail } = vi.hoisted(() => ({ signInEmail: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: signInEmail } },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import LoginPage from "./page";

const submit = () => {
  fireEvent.change(screen.getByLabelText(/Email Address/), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Password/), {
    target: { value: "Original1pass" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Sign In/ }));
};

beforeEach(() => {
  signInEmail.mockReset();
});

describe("LoginPage", () => {
  it("tells an unverified user a new link is on its way", async () => {
    signInEmail.mockImplementation(async (_body, { onError }) =>
      onError({
        error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
      }),
    );
    render(<LoginPage />);

    submit();

    expect(
      await screen.findByText(/sent a new verification link/),
    ).toBeInTheDocument();
  });

  it("shows the server message for other sign-in errors", async () => {
    signInEmail.mockImplementation(async (_body, { onError }) =>
      onError({
        error: {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        },
      }),
    );
    render(<LoginPage />);

    submit();

    expect(
      await screen.findByText("Invalid email or password"),
    ).toBeInTheDocument();
  });
});
