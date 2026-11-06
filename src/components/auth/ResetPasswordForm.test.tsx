// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetPassword, params } = vi.hoisted(() => ({
  resetPassword: vi.fn(),
  params: { value: new URLSearchParams() },
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { resetPassword } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.value }));

import { ResetPasswordForm } from "./ResetPasswordForm";

const submit = (password: string, confirm: string) => {
  fireEvent.change(screen.getByLabelText(/^New Password/), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/^Confirm New Password/), {
    target: { value: confirm },
  });
  fireEvent.click(screen.getByRole("button", { name: /Reset Password/ }));
};

beforeEach(() => {
  resetPassword.mockReset();
  params.value = new URLSearchParams("token=tok123");
});

describe("ResetPasswordForm", () => {
  it("submits the token and new password, then links to sign-in", async () => {
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });
    render(<ResetPasswordForm />);

    submit("Changed2pass", "Changed2pass");

    expect(await screen.findByText("Password Updated")).toBeInTheDocument();
    expect(resetPassword).toHaveBeenCalledWith({
      newPassword: "Changed2pass",
      token: "tok123",
    });
    expect(screen.getByRole("link", { name: /Sign In/ })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("rejects mismatched passwords without calling the API", async () => {
    render(<ResetPasswordForm />);

    submit("Changed2pass", "Different3pass");

    expect(
      (await screen.findAllByText(/Passwords don.t match/)).length,
    ).toBeGreaterThan(0);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejects a weak password without calling the API", async () => {
    render(<ResetPasswordForm />);

    submit("weak", "weak");

    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("offers a new link when the token is expired or invalid", async () => {
    resetPassword.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TOKEN", status: 400 },
    });
    render(<ResetPasswordForm />);

    submit("Changed2pass", "Changed2pass");

    expect(await screen.findByText(/invalid or has expired/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Request a New Link/ }),
    ).toHaveAttribute("href", "/forgot-password");
  });

  it("offers a new link instead of a form when the token is missing", () => {
    params.value = new URLSearchParams();

    render(<ResetPasswordForm />);

    expect(screen.queryByLabelText(/^New Password/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Request a New Link/ }),
    ).toHaveAttribute("href", "/forgot-password");
  });
});
