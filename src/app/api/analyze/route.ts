import { after, NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { AnalysisService } from "@/lib/services/analysisService";
import { handleApiError } from "@/lib/api-utils";
import { postToBackend } from "@/lib/backend-client";
import { db } from "@/lib/db/client";
import { user as userTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
    ALLOWED_UPLOAD_EXTENSIONS,
    DAILY_UPLOAD_LIMIT,
    MAX_UPLOAD_SIZE_BYTES,
} from "@/lib/constants/UserConstants";
import { refundDailyUpload } from "@/lib/services/quotaService";

function backendErrorDetail(body: string): string {
    try {
        const { detail } = JSON.parse(body);
        if (typeof detail === "string") return detail;
    } catch {
        // Not JSON (e.g. a proxy error page): fall through to the generic message.
    }
    return "The document could not be processed.";
}

export async function POST(req: NextRequest) {
    let quotaReservedFor: string | null = null;
    try {
        const session = await getSession();
        if (!session?.user?.id) {
            return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        const userId = session.user.id;

        const formData = await req.formData().catch(() => null);
        const file = formData?.get("file");

        if (!(file instanceof File)) {
            return NextResponse.json({ success: false, error: "No file uploaded" }, { status: 400 });
        }

        if (file.size > MAX_UPLOAD_SIZE_BYTES) {
            return NextResponse.json({ success: false, error: "File size must be less than 10MB." }, { status: 413 });
        }

        const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
        if (!ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
            return NextResponse.json({ success: false, error: `Unsupported file type: ${extension}` }, { status: 415 });
        }

        // Check + increment the daily upload limit atomically: a plain
        // read-then-write here lets concurrent requests (e.g. two tabs, or a
        // double-click) all read the same pre-increment count and all pass
        // the check, exceeding DAILY_UPLOAD_LIMIT. FOR UPDATE locks the row
        // for the duration of the transaction so concurrent callers queue
        // instead of racing.
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const limitCheckResult = await db.transaction(async (tx) => {
            const [currentUser] = await tx
                .select()
                .from(userTable)
                .where(eq(userTable.id, userId))
                .for("update");

            if (!currentUser) {
                return "NOT_FOUND" as const;
            }

            let uploadCount = currentUser.dailyUploadCount || 0;
            if (!currentUser.lastUploadDate || new Date(currentUser.lastUploadDate) < todayStart) {
                uploadCount = 0;
            }

            if (uploadCount >= DAILY_UPLOAD_LIMIT) {
                return "LIMIT_REACHED" as const;
            }

            await tx
                .update(userTable)
                .set({
                    dailyUploadCount: uploadCount + 1,
                    lastUploadDate: new Date(),
                })
                .where(eq(userTable.id, userId));

            return "OK" as const;
        });

        if (limitCheckResult === "NOT_FOUND") {
            return NextResponse.json({ success: false, error: "User not found" }, { status: 404 });
        }

        if (limitCheckResult === "LIMIT_REACHED") {
            return NextResponse.json({
                success: false,
                error: `Daily limit reached. You can only upload ${DAILY_UPLOAD_LIMIT} documents per day.`
            }, { status: 429 });
        }

        quotaReservedFor = userId;

        // Prepare request to Python backend
        const backendFormData = new FormData();
        backendFormData.append("file", file);
        const response = await postToBackend("/analyze/", backendFormData, { 'Accept': 'text/event-stream' });

        if (!response.ok || !response.body) {
            const errorText = await response.text();
            if (response.status >= 400 && response.status < 500) {
                await refundDailyUpload(userId);
                return NextResponse.json(
                    { success: false, error: backendErrorDetail(errorText) },
                    { status: response.status }
                );
            }
            throw new Error(`Backend error (${response.status}): ${errorText}`);
        }

        const [dbStreamClone, forwardStream] = response.body.tee();

        // Start reading now and pass after() the promise, not a callback: a
        // callback would only run once the response closes, leaving this tee
        // branch to buffer the whole stream in memory until then. The promise
        // form hands the save to waitUntil immediately, so it outlives the
        // response and a client disconnect, up to the function's max duration.
        after(AnalysisService.collectAndSaveAnalysis(dbStreamClone, userId, file.name));

        const headers: Record<string, string> = {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Connection": "keep-alive",
        };
        const sessionId = response.headers.get('X-Session-ID');
        if (sessionId) {
            headers["X-Session-ID"] = sessionId;
        }

        return new NextResponse(forwardStream, { headers });

    } catch (error) {
        if (quotaReservedFor) {
            await refundDailyUpload(quotaReservedFor);
        }
        return handleApiError(error);
    }
}
