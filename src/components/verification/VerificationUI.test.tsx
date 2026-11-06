// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyEmail, params } = vi.hoisted(() => ({
  verifyEmail: vi.fn(),
  params: { value: new URLSearchParams() },
}));

vi.mock("@/lib/auth-client", () => ({ authClient: { verifyEmail } }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.value }));

import { VerificationUI } from "./VerificationUI";

beforeEach(() => {
  verifyEmail.mockReset();
  params.value = new URLSearchParams("token=tok123");
});

describe("VerificationUI", () => {
  it("verifies the token and sends the now signed-in user to the dashboard", async () => {
    verifyEmail.mockResolvedValue({ data: { status: true }, error: null });

    render(<VerificationUI />);

    expect(await screen.findByText("Email Verified!")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith({ query: { token: "tok123" } });
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/document-analysis",
    );
  });

  it("offers a new link through sign-in when the token is rejected", async () => {
    verifyEmail.mockResolvedValue({
      data: null,
      error: { code: "TOKEN_EXPIRED", status: 401 },
    });

    render(<VerificationUI />);

    expect(await screen.findByText("Verification Failed")).toBeInTheDocument();
    expect(screen.getByText(/invalid or has expired/)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/login");
  });

  it("shows a connection message when the request throws", async () => {
    verifyEmail.mockRejectedValue(new Error("offline"));

    render(<VerificationUI />);

    expect(await screen.findByText(/check your connection/)).toBeInTheDocument();
  });

  it("reports a link without a token and calls nothing", async () => {
    params.value = new URLSearchParams();

    render(<VerificationUI />);

    expect(await screen.findByText(/No token provided/)).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });
});
