import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { user as userTable } from "@/lib/db/schema";

// Never throws: callers are already handling the failure that triggered the
// refund, and that error is the one the user needs to see.
export async function refundDailyUpload(userId: string): Promise<void> {
    try {
        await db
            .update(userTable)
            .set({ dailyUploadCount: sql`GREATEST(${userTable.dailyUploadCount} - 1, 0)` })
            .where(eq(userTable.id, userId));
    } catch (error) {
        console.error(`[Quota] Failed to refund daily upload for user ${userId}:`, error);
    }
}
