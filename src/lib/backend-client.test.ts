import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SECRET = "test-shared-secret";

vi.mock("@/lib/auth-server", () => ({
  getSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/db/client", () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => [{ dailyUploadCount: 0, lastUploadDate: null }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return {
    db: {
      transaction: async (work: (t: typeof tx) => unknown) => work(tx),
      insert: () => ({ values: async () => undefined }),
    },
  };
});

function uploadRequest(path: string, headers: Record<string, string> = {}) {
  const body = new FormData();
  body.append("file", new File(["contract text"], "contract.txt", { type: "text/plain" }));
  return new NextRequest(`http://localhost${path}`, { method: "POST", body, headers });
}

function sseResponse() {
  return new Response('data: {"step":"done"}\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function loadRoute(name: "demo" | "analyze") {
  return name === "demo"
    ? await import("@/app/api/demo/route")
    : await import("@/app/api/analyze/route");
}

describe.each([
  ["demo", "/api/demo", "http://backend.test/demo/"],
  ["analyze", "/api/analyze", "http://backend.test/analyze/"],
] as const)("%s route to backend", (name, path, backendUrl) => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WEB_URL", "http://backend.test");
    vi.stubEnv("BACKEND_API_SECRET", SECRET);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("sends the shared secret to the backend", async () => {
    const { POST } = await loadRoute(name);

    const response = await POST(uploadRequest(path));

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(backendUrl);
    expect(new Headers(init.headers).get("X-Internal-Secret")).toBe(SECRET);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("never exposes the secret in a successful response", async () => {
    const { POST } = await loadRoute(name);

    const response = await POST(uploadRequest(path));

    expect(await response.text()).not.toContain(SECRET);
    expect(JSON.stringify([...response.headers])).not.toContain(SECRET);
  });

  it("never exposes the secret when the backend rejects the call", async () => {
    fetchMock.mockImplementation(
      async () => new Response('{"detail":"Unauthorized"}', { status: 401 })
    );
    const { POST } = await loadRoute(name);

    const response = await POST(uploadRequest(path));

    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("does not call the backend when the secret is not configured", async () => {
    vi.stubEnv("BACKEND_API_SECRET", "");
    const { POST } = await loadRoute(name);

    const response = await POST(uploadRequest(path));

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("demo route client IP", () => {
  it("forwards only the visitor's IP via getClientIp", async () => {
    const fetchMock = vi.fn(async () => sseResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("WEB_URL", "http://backend.test");
    vi.stubEnv("BACKEND_API_SECRET", SECRET);
    const { POST } = await loadRoute("demo");

    await POST(uploadRequest("/api/demo", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("X-Forwarded-For")).toBe("203.0.113.9");
  });
});

describe("postToBackend", () => {
  it("throws a clear error when the secret is missing", async () => {
    vi.stubEnv("BACKEND_API_SECRET", "");
    const { postToBackend } = await import("@/lib/backend-client");

    expect(() => postToBackend("/demo/", new FormData())).toThrow(
      "BACKEND_API_SECRET is not configured"
    );
  });
});
