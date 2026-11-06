import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    savedRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/server", async (importOriginal) => ({
    ...(await importOriginal<typeof import("next/server")>()),
    after: mocks.after,
}));

vi.mock("@/lib/auth-server", () => ({
    getSession: async () => ({ user: { id: "user-1" } }),
}));

vi.mock("@/lib/db/client", () => {
    // The quota transaction is not under test: any query chain resolves to a user under the limit.
    const chain = (): unknown =>
        new Proxy(function () {}, {
            get: (_target, prop) =>
                prop === "then"
                    ? (resolve: (rows: unknown[]) => void) =>
                          resolve([{ id: "user-1", dailyUploadCount: 0, lastUploadDate: null }])
                    : chain(),
            apply: () => chain(),
        });
    return {
        db: {
            transaction: (run: (tx: unknown) => unknown) => run(chain()),
            insert: () => ({
                values: (row: Record<string, unknown>) => ({
                    onConflictDoNothing: async () => {
                        mocks.savedRows.push(row);
                    },
                }),
            }),
        },
    };
});

const encoder = new TextEncoder();
const RESULT_EVENT = `data: ${JSON.stringify({
    final_result: {
        type: "legal_analysis",
        analysis: { summary: "An NDA.", verdict: "safe", risks: [] },
    },
})}\n\n`;

function controllableBackend() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
        },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    return controller;
}

function uploadRequest() {
    const form = new FormData();
    form.append("file", new File(["contract text"], "nda.txt", { type: "text/plain" }));
    return new NextRequest("http://localhost/api/analyze", { method: "POST", body: form });
}

function registeredSave() {
    expect(mocks.after).toHaveBeenCalledTimes(1);
    const task = mocks.after.mock.calls[0][0];
    return typeof task === "function" ? task() : task;
}

describe("POST /api/analyze durable save", () => {
    beforeEach(() => {
        vi.stubEnv("BACKEND_API_SECRET", "test-shared-secret");
        mocks.after.mockReset();
        mocks.savedRows = [];
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("registers the save with after() so it outlives the response", async () => {
        const backend = controllableBackend();

        const response = await POST(uploadRequest());
        expect(response.status).toBe(200);
        const save = registeredSave();
        expect(mocks.savedRows).toEqual([]);

        backend.enqueue(encoder.encode(RESULT_EVENT));
        backend.close();
        await save;
        await response.text();

        expect(mocks.savedRows).toHaveLength(1);
        expect(mocks.savedRows[0]).toMatchObject({ userId: "user-1", documentName: "nda.txt", summary: "An NDA." });
    });

    it("forwards the stream to the client while the save reads the same events", async () => {
        const backend = controllableBackend();
        const response = await POST(uploadRequest());
        const save = registeredSave();

        backend.enqueue(encoder.encode(RESULT_EVENT));
        backend.close();

        // Both tee branches drain concurrently, in either order, without deadlocking.
        expect(await response.text()).toBe(RESULT_EVENT);
        await save;
        expect(mocks.savedRows).toHaveLength(1);
    });

    it("still completes the save when the client disconnects mid-stream", async () => {
        const backend = controllableBackend();
        const response = await POST(uploadRequest());
        const save = registeredSave();

        backend.enqueue(encoder.encode('data: {"step":"summary"}\n\n'));
        // Not awaited: a tee branch's cancel() only settles once both branches
        // are finished, which is also why the backend keeps flowing to the save.
        void response.body!.cancel();
        backend.enqueue(encoder.encode(RESULT_EVENT));
        backend.close();
        await save;

        expect(mocks.savedRows).toHaveLength(1);
    });
});
