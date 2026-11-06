import { db } from "@/lib/db/client";
import { analyses } from "@/lib/db/schema";
import { LegalAnalysisResult, parseStreamData } from "@/lib/types";
import { DrizzleQueryError } from "drizzle-orm/errors";

const MAX_INSERT_ATTEMPTS = 2;
const INSERT_RETRY_DELAY_MS = 500;

// A DrizzleQueryError's message embeds the query params, which hold the
// document's summary and risks, so only its underlying cause may be logged.
function safeErrorMessage(error: unknown): string {
    const source = error instanceof DrizzleQueryError ? error.cause : error;
    return source instanceof Error ? source.message : "Unknown error";
}

async function insertWithRetry(row: typeof analyses.$inferInsert) {
    for (let attempt = 1; ; attempt++) {
        try {
            // A lost acknowledgement can mean the first attempt committed; the
            // retry reuses the row's id, so it must not insert a second copy.
            await db.insert(analyses).values(row).onConflictDoNothing();
            return;
        } catch (error) {
            if (attempt >= MAX_INSERT_ATTEMPTS) throw error;
            console.warn(`[AnalysisService] Insert attempt ${attempt} failed, retrying: ${safeErrorMessage(error)}`);
            await new Promise((resolve) => setTimeout(resolve, INSERT_RETRY_DELAY_MS));
        }
    }
}

export class AnalysisService {
    static async collectAndSaveAnalysis(
        stream: ReadableStream<Uint8Array>,
        userId: string,
        documentName: string
    ) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let fullStreamContent = "";
        console.log(`[AnalysisService] Starting to collect stream for user: ${userId}`);

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullStreamContent += decoder.decode(value, { stream: true });
            }

            // Parse SSE data
            const lines = fullStreamContent.split('\n');
            let analysisResult: LegalAnalysisResult['analysis'] | null = null;

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    const dataString = line.substring(5).trim();
                    try {
                        const parsedData = JSON.parse(dataString);
                        const finalResult = parseStreamData(parsedData);
                        if (finalResult && finalResult.type === 'legal_analysis') {
                            analysisResult = finalResult.analysis;
                        }
                    } catch {
                        // Ignore partial JSON chunks
                    }
                }
            }

            if (!analysisResult) {
                console.error("[AnalysisService] No valid JSON analysis objects found.");
                return;
            }

            if (analysisResult.summary && analysisResult.risks && analysisResult.verdict) {
                await insertWithRetry({
                    id: crypto.randomUUID(),
                    userId,
                    documentName,
                    documentType: 'General',
                    summary: analysisResult.summary,
                    risks: analysisResult.risks.filter(Boolean),
                    verdict: analysisResult.verdict,
                });

                console.log(`[AnalysisService] Successfully saved analysis for: ${documentName}`);
            } else {
                console.error("[AnalysisService] Missing required fields in analysis result.");
            }
        } catch (error) {
            console.error(
                `[AnalysisService] ANALYSIS NOT SAVED for user ${userId}, document "${documentName}": ${safeErrorMessage(error)}`
            );
        }
    }
}
