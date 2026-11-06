import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { getSession } from "@/lib/auth-server";
import { AnalysisService } from "@/lib/services/analysisService";
import { POST } from "./route";

// In-memory stand-in for the single `user` row the route reserves against.
// Refunds reach it as raw SQL, so that SQL is rendered and matched rather than
// trusted: anything but the expected decrement fails the test.
const fakeDb = vi.hoisted(() => ({
  row: null as { dailyUploadCount: number; lastUploadDate: Date | null } | null,
  transactions: 0,
  failRefund: false,
  refundSql: [] as string[],
}));

vi.mock("@/lib/auth-server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/services/analysisService", () => ({
  AnalysisService: { collectAndSaveAnalysis: vi.fn() },
}));
vi.mock("@/lib/db/client", () => {
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        if (values.dailyUploadCount instanceof SQL) {
          if (fakeDb.failRefund) throw new Error("db down");
          const rendered = new PgDialect().sqlToQuery(values.dailyUploadCount).sql;
          fakeDb.refundSql.push(rendered);
          if (fakeDb.row) {
            fakeDb.row.dailyUploadCount = Math.max(fakeDb.row.dailyUploadCount - 1, 0);
          }
          return;
        }
        Object.assign(fakeDb.row!, values);
      },
    }),
  });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: async () => (fakeDb.row ? [{ ...fakeDb.row }] : []),
        }),
      }),
    }),
    update,
  };
  return {
    db: {
      update,
      transaction: async (fn: (t: typeof tx) => unknown) => {
        fakeDb.transactions += 1;
        return fn(tx);
      },
    },
  };
});

const TEN_MB = 10485760;

function uploadRequest(file?: File) {
  const body = new FormData();
  if (file) body.append("file", file);
  return new NextRequest("http://localhost/api/analyze", { method: "POST", body });
}

const txtFile = (name = "contract.txt") => new File(["some contract text"], name);

function stubBackend(impl: () => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const streamOk = () => Promise.resolve(new Response("data: [DONE]\n\n", { status: 200 }));

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockResolvedValue({ user: { id: "user-1" } } as never);
  vi.mocked(AnalysisService.collectAndSaveAnalysis).mockReset();
  vi.mocked(AnalysisService.collectAndSaveAnalysis).mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  fakeDb.row = { dailyUploadCount: 1, lastUploadDate: new Date() };
  fakeDb.transactions = 0;
  fakeDb.failRefund = false;
  fakeDb.refundSql = [];
});

describe("POST /api/analyze: requests that must cost nothing", () => {
  it("returns 401 for an unauthenticated caller without touching the db", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const backend = stubBackend(streamOk);

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(401);
    expect(fakeDb.transactions).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing file without touching the quota", async () => {
    const backend = stubBackend(streamOk);

    const res = await POST(uploadRequest());

    expect(res.status).toBe(400);
    expect(fakeDb.transactions).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it("returns 400 for a body that is not multipart without touching the quota", async () => {
    const backend = stubBackend(streamOk);
    const req = new NextRequest("http://localhost/api/analyze", {
      method: "POST",
      body: "not a form",
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(fakeDb.transactions).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it("returns 400 when the file field is a plain string", async () => {
    const backend = stubBackend(streamOk);
    const body = new FormData();
    body.append("file", "just text");

    const res = await POST(
      new NextRequest("http://localhost/api/analyze", { method: "POST", body })
    );

    expect(res.status).toBe(400);
    expect(fakeDb.transactions).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over 10 MB without touching the quota", async () => {
    const backend = stubBackend(streamOk);
    const oversized = new File([new Uint8Array(TEN_MB + 1)], "big.pdf");

    const res = await POST(uploadRequest(oversized));

    expect(res.status).toBe(413);
    expect(fakeDb.transactions).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it.each(["malware.exe", "notes.md", "contract.pdf.zip", "noextension"])(
    "returns 415 for %s without touching the quota",
    async (name) => {
      const backend = stubBackend(streamOk);

      const res = await POST(uploadRequest(txtFile(name)));

      expect(res.status).toBe(415);
      expect(fakeDb.transactions).toBe(0);
      expect(backend).not.toHaveBeenCalled();
    }
  );

  it("returns 429 at the daily limit and never calls the backend", async () => {
    fakeDb.row = { dailyUploadCount: 3, lastUploadDate: new Date() };
    const backend = stubBackend(streamOk);

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(429);
    expect(fakeDb.row.dailyUploadCount).toBe(3);
    expect(backend).not.toHaveBeenCalled();
  });
});

describe("POST /api/analyze: accepted uploads", () => {
  it("reserves exactly once and streams the backend response", async () => {
    const backend = stubBackend(streamOk);

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: [DONE]\n\n");
    expect(fakeDb.transactions).toBe(1);
    expect(fakeDb.row?.dailyUploadCount).toBe(2);
    expect(fakeDb.refundSql).toEqual([]);
    expect(backend).toHaveBeenCalledTimes(1);
    expect(AnalysisService.collectAndSaveAnalysis).toHaveBeenCalledTimes(1);
  });

  // The backend accepts all of these today, images via OCR and any case of
  // extension, so the route must not start rejecting them.
  it.each(["a.pdf", "a.docx", "a.txt", "a.png", "a.jpg", "a.jpeg", "CONTRACT.PDF"])(
    "accepts %s",
    async (name) => {
      stubBackend(streamOk);

      const res = await POST(uploadRequest(txtFile(name)));

      expect(res.status).toBe(200);
    }
  );

  it("accepts a file of exactly 10 MB", async () => {
    stubBackend(streamOk);

    const res = await POST(uploadRequest(new File([new Uint8Array(TEN_MB)], "big.pdf")));

    expect(res.status).toBe(200);
  });
});

describe("POST /api/analyze: refunds", () => {
  it("refunds and passes through a backend 400 with its detail", async () => {
    stubBackend(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: "PDF processing failed: corrupt" }), { status: 400 })
      )
    );

    const res = await POST(uploadRequest(txtFile("broken.pdf")));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: "PDF processing failed: corrupt",
    });
    expect(fakeDb.row?.dailyUploadCount).toBe(1);
    expect(fakeDb.refundSql).toHaveLength(1);
  });

  it("uses a generic message when a backend 4xx has no string detail", async () => {
    stubBackend(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: [{ loc: ["file"] }] }), { status: 422 }))
    );

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      success: false,
      error: "The document could not be processed.",
    });
    expect(fakeDb.row?.dailyUploadCount).toBe(1);
  });

  it("refunds exactly once and returns 500 on a backend 5xx", async () => {
    stubBackend(() => Promise.resolve(new Response("boom", { status: 503 })));

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(500);
    expect(fakeDb.refundSql).toHaveLength(1);
    expect(fakeDb.row?.dailyUploadCount).toBe(1);
  });

  it("refunds and returns 500 when the backend is unreachable", async () => {
    stubBackend(() => Promise.reject(new TypeError("fetch failed")));

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "fetch failed" });
    expect(fakeDb.row?.dailyUploadCount).toBe(1);
  });

  it("does not refund when the failure happened before any reservation", async () => {
    vi.mocked(getSession).mockRejectedValue(new Error("auth down"));
    stubBackend(streamOk);

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(500);
    expect(fakeDb.refundSql).toEqual([]);
  });

  it("refunds with one decrement that cannot go below zero", async () => {
    stubBackend(() => Promise.resolve(new Response("{}", { status: 400 })));

    await POST(uploadRequest(txtFile()));

    expect(fakeDb.refundSql).toEqual(['GREATEST("user"."daily_upload_count" - 1, 0)']);
  });

  it("keeps the unreachable-backend error when the refund itself fails, and logs it", async () => {
    fakeDb.failRefund = true;
    stubBackend(() => Promise.reject(new TypeError("fetch failed")));

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: "fetch failed" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("refund"),
      expect.any(Error)
    );
  });

  it("keeps the backend 400 when the refund itself fails", async () => {
    fakeDb.failRefund = true;
    stubBackend(() =>
      Promise.resolve(new Response(JSON.stringify({ detail: "Unsupported" }), { status: 400 }))
    );

    const res = await POST(uploadRequest(txtFile()));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: "Unsupported" });
  });
});
