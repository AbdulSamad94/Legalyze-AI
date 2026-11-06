import { DrizzleQueryError } from "drizzle-orm/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisService } from "./analysisService";

type Row = Record<string, unknown> & { id: string };

const fakeDb = vi.hoisted(() => ({
    rows: [] as Row[],
    // Each entry decides how one insert attempt behaves, in order.
    attempts: [] as Array<{ fail?: Error; commitThenFail?: Error }>,
    insertCalls: 0,
}));

vi.mock("@/lib/db/client", () => ({
    db: {
        insert: () => ({
            values: (row: Row) => ({
                onConflictDoNothing: async () => {
                    fakeDb.insertCalls += 1;
                    const attempt = fakeDb.attempts.shift() ?? {};
                    if (attempt.fail) throw attempt.fail;
                    if (!fakeDb.rows.some((existing) => existing.id === row.id)) {
                        fakeDb.rows.push(row);
                    }
                    if (attempt.commitThenFail) throw attempt.commitThenFail;
                },
            }),
        }),
    },
}));

const COMPLETE_EVENT = `data: ${JSON.stringify({
    final_result: {
        type: "legal_analysis",
        analysis: {
            summary: "An NDA between two parties.",
            verdict: "safe",
            risks: [
                {
                    description: "Broad scope",
                    level: "HIGH",
                    category: "Scope",
                    recommendation: "Narrow it",
                    clause_reference: "2.1",
                },
            ],
        },
    },
})}\n\n`;

function streamOf(...chunks: Array<string | Uint8Array>) {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
            }
            controller.close();
        },
    });
}

function save(stream: ReadableStream<Uint8Array>) {
    return AnalysisService.collectAndSaveAnalysis(stream, "user-1", "nda.txt");
}

function loggedErrors(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
}

describe("AnalysisService.collectAndSaveAnalysis", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        fakeDb.rows = [];
        fakeDb.attempts = [];
        fakeDb.insertCalls = 0;
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    it("saves one row with the expected fields from a complete stream", async () => {
        await save(streamOf('data: {"step":"summary"}\n\n', COMPLETE_EVENT, "data: [DONE]\n\n"));

        expect(fakeDb.rows).toEqual([
            {
                id: expect.any(String),
                userId: "user-1",
                documentName: "nda.txt",
                documentType: "General",
                summary: "An NDA between two parties.",
                verdict: "safe",
                risks: [
                    {
                        description: "Broad scope",
                        level: "high",
                        category: "Scope",
                        recommendation: "Narrow it",
                        clause_reference: "2.1",
                    },
                ],
            },
        ]);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("saves an event split across chunks, even inside a multi-byte character", async () => {
        const event = new TextEncoder().encode(
            `data: ${JSON.stringify({
                final_result: {
                    type: "legal_analysis",
                    analysis: { summary: "Résumé", verdict: "safe", risks: [] },
                },
            })}\n\n`
        );
        const splitInsideE9 = event.findIndex((byte) => byte === 0xc3) + 1;

        await save(streamOf(event.slice(0, splitInsideE9), event.slice(splitInsideE9)));

        expect(fakeDb.rows).toHaveLength(1);
        expect(fakeDb.rows[0].summary).toBe("Résumé");
    });

    it.each([
        ["an error result", 'data: {"final_result":{"type":"error","message":"boom"}}\n\ndata: [DONE]\n\n'],
        ["a [DONE]-only stream", "data: [DONE]\n\n"],
    ])("saves nothing for %s", async (_name, body) => {
        await save(streamOf(body));

        expect(fakeDb.insertCalls).toBe(0);
        expect(fakeDb.rows).toEqual([]);
    });

    it("retries a failed insert and saves one row without logging an error", async () => {
        fakeDb.attempts = [{ fail: new Error("connection reset") }];

        await save(streamOf(COMPLETE_EVENT));

        expect(fakeDb.insertCalls).toBe(2);
        expect(fakeDb.rows).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does not duplicate the row when a commit succeeded but its acknowledgement was lost", async () => {
        fakeDb.attempts = [{ commitThenFail: new Error("connection reset") }];

        await save(streamOf(COMPLETE_EVENT));

        expect(fakeDb.rows).toHaveLength(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("logs an error naming the user and document, and resolves, when all attempts fail", async () => {
        fakeDb.attempts = [
            { fail: new Error("connection reset") },
            { fail: new Error("connection reset") },
            { fail: new Error("connection reset") },
        ];

        await expect(save(streamOf(COMPLETE_EVENT))).resolves.toBeUndefined();

        expect(fakeDb.insertCalls).toBe(2);
        expect(fakeDb.rows).toEqual([]);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = loggedErrors(errorSpy);
        expect(logged).toContain("user-1");
        expect(logged).toContain("nda.txt");
        expect(logged).toContain("connection reset");
    });

    it("never logs document contents carried in a Drizzle query error's params", async () => {
        const failure = new DrizzleQueryError(
            'insert into "analyses"',
            ["An NDA between two parties."],
            new Error("connection reset")
        );
        fakeDb.attempts = [{ fail: failure }, { fail: failure }];

        await save(streamOf(COMPLETE_EVENT));

        const logged = loggedErrors(errorSpy) + loggedErrors(warnSpy);
        expect(logged).toContain("connection reset");
        expect(logged).not.toContain("An NDA between two parties.");
    });

    it("logs an error and resolves when the stream itself fails", async () => {
        const stream = new ReadableStream<Uint8Array>({
            pull() {
                throw new Error("upstream died");
            },
        });

        await expect(save(stream)).resolves.toBeUndefined();

        expect(fakeDb.rows).toEqual([]);
        expect(loggedErrors(errorSpy)).toContain("nda.txt");
    });
});
