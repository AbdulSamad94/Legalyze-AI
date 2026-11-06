// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestPasswordReset } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { requestPasswordReset } }));

import ForgotPasswordPage from "./page";

const submit = (email: string) => {
  fireEvent.change(screen.getByLabelText(/Email Address/), {
    target: { value: email },
  });
  fireEvent.click(screen.getByRole("button", { name: /Send Reset Link/ }));
};

const CONFIRMATION = /If an account exists for that address/;

beforeEach(() => {
  requestPasswordReset.mockReset();
});

describe("ForgotPasswordPage", () => {
  it("requests a reset and shows the neutral confirmation", async () => {
    requestPasswordReset.mockResolvedValue({ data: { status: true } });
    render(<ForgotPasswordPage />);

    submit("user@example.com");

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument();
    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: "user@example.com",
    });
  });

  it("shows the same confirmation when the API returns an error", async () => {
    requestPasswordReset.mockResolvedValue({ error: { status: 500 } });
    render(<ForgotPasswordPage />);

    submit("user@example.com");

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument();
  });

  it("shows the same confirmation when the request throws", async () => {
    requestPasswordReset.mockRejectedValue(new Error("offline"));
    render(<ForgotPasswordPage />);

    submit("user@example.com");

    expect(await screen.findByText(CONFIRMATION)).toBeInTheDocument();
  });

  it("rejects a malformed address without calling the API", async () => {
    render(<ForgotPasswordPage />);

    submit("not-an-email");

    expect(
      await screen.findByText("Please enter a valid email address"),
    ).toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});
