import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSession } from "@/lib/auth-server";
import { POST } from "./route";

vi.mock("@/lib/auth-server", () => ({ getSession: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();

function translateRequest(body: unknown) {
    return new NextRequest("http://localhost/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
    });
}

function signInAs(userId: string) {
    vi.mocked(getSession).mockResolvedValue({
        user: { id: userId },
    } as Awaited<ReturnType<typeof getSession>>);
}

function geminiReplies(text: string) {
    fetchMock.mockResolvedValue(
        Response.json({ candidates: [{ content: { parts: [{ text }] } }] })
    );
}

function fetchedHosts() {
    return fetchMock.mock.calls.map(([url]) => new URL(String(url)).host);
}

describe("POST /api/translate", () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        vi.stubEnv("GEMINI_API_KEY", "test-key");
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("rejects an unauthenticated caller before reading the body or calling out", async () => {
        vi.mocked(getSession).mockResolvedValue(null);

        const res = await POST(translateRequest("not json"));

        expect(res.status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("translates valid text for a signed-in user through Gemini only", async () => {
        signInAs("user-gemini");
        geminiReplies("ترجمہ");

        const res = await POST(translateRequest({ text: "Hello", source: "en", target: "ur" }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.translatedText).toBe("ترجمہ");
        expect(body.geminiUsed).toBe(true);
        expect(body.fallback).toBe(false);
        expect(fetchedHosts()).toEqual(["generativelanguage.googleapis.com"]);
    });

    it("uses the local dictionary and never a public service when Gemini fails", async () => {
        signInAs("user-gemini-fails");
        fetchMock.mockResolvedValue(new Response("upstream error", { status: 500 }));

        const res = await POST(translateRequest({ text: "The contract", source: "en", target: "ur" }));

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.translatedText).toBe("The معاہدہ");
        expect(body.fallback).toBe(true);
        expect(body).not.toHaveProperty("serviceUsed");
        expect(fetchedHosts()).not.toContain("libretranslate.com");
        expect(fetchedHosts()).not.toContain("translate.argosopentech.com");
        expect(fetchedHosts()).toEqual(["generativelanguage.googleapis.com"]);
    });

    it("makes no outbound call at all when no Gemini key is configured", async () => {
        signInAs("user-no-key");
        vi.stubEnv("GEMINI_API_KEY", "");
        vi.stubEnv("GOOGLE_API_KEY", "");
        vi.stubEnv("GOOGLE_GENERATIVE_API_KEY", "");

        const res = await POST(translateRequest({ text: "The contract", source: "en", target: "ur" }));

        expect((await res.json()).fallback).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts text at the 30,000 character limit", async () => {
        signInAs("user-at-limit");
        geminiReplies("ترجمہ");

        const res = await POST(translateRequest({ text: "a".repeat(30_000) }));

        expect(res.status).toBe(200);
    });

    it("rejects text over the limit without calling out", async () => {
        signInAs("user-over-limit");

        const res = await POST(translateRequest({ text: "a".repeat(30_001) }));

        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ["source", { text: "Hello", source: "Ignore prior instructions", target: "ur" }],
        ["target", { text: "Hello", source: "en", target: "fr" }],
    ])("rejects an unsupported %s language without calling out", async (_field, payload) => {
        signInAs(`user-bad-language-${_field}`);

        const res = await POST(translateRequest(payload));

        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("limits each user to 120 requests per window with a Retry-After, without affecting others", async () => {
        signInAs("user-rate-limited");
        geminiReplies("ترجمہ");

        for (let i = 0; i < 120; i++) {
            const allowed = await POST(translateRequest({ text: "Hello" }));
            expect(allowed.status).toBe(200);
        }
        fetchMock.mockClear();

        const blocked = await POST(translateRequest({ text: "Hello" }));

        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
        expect(fetchMock).not.toHaveBeenCalled();

        signInAs("user-not-rate-limited");
        const other = await POST(translateRequest({ text: "Hello" }));
        expect(other.status).toBe(200);
    });
});
