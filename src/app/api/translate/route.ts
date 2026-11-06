import { NextRequest, NextResponse } from "next/server";
import { translateSchema } from "@/lib/validators/translate";
import { TranslationService } from "@/lib/services/translationService";
import { handleApiError } from "@/lib/api-utils";
import { getSession } from "@/lib/auth-server";
import { checkRateLimit } from "@/lib/rate-limit";

// ResultsView falls back to 2 + 2-per-risk calls when a combined translation
// can't be parsed, so one analysis can legitimately take dozens of requests.
const TRANSLATE_RATE_LIMIT_MAX = 120;
const TRANSLATE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function POST(req: NextRequest) {
    try {
        const session = await getSession();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const { allowed, retryAfterSeconds } = checkRateLimit(
            `translate:${session.user.id}`,
            TRANSLATE_RATE_LIMIT_MAX,
            TRANSLATE_RATE_LIMIT_WINDOW_MS
        );
        if (!allowed) {
            return NextResponse.json(
                { success: false, error: "Too many translation requests. Please try again later." },
                { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
            );
        }

        const body = await req.json();

        // 1. Validation (Zod)
        const validatedData = translateSchema.parse(body);

        // 2. Service Call
        const result = await TranslationService.translate(validatedData);

        // 3. Response
        return NextResponse.json({
            success: true,
            translatedText: result.translatedText,
            chunksProcessed: 1,
            geminiUsed: result.method === "gemini",
            fallback: result.method === "fallback",
        });

    } catch (error) {
        return handleApiError(error);
    }
}
