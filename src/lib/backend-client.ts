/**
 * Server-only: BACKEND_API_SECRET authenticates this app to the FastAPI backend
 * and must never get a NEXT_PUBLIC_ prefix or reach the browser.
 */
export function postToBackend(
    path: "/demo/" | "/analyze/",
    body: FormData,
    headers: Record<string, string> = {}
): Promise<Response> {
    const secret = process.env.BACKEND_API_SECRET;
    if (!secret) {
        throw new Error("BACKEND_API_SECRET is not configured");
    }

    return fetch(`${process.env.WEB_URL || "http://127.0.0.1:8000"}${path}`, {
        method: "POST",
        body,
        headers: { ...headers, "X-Internal-Secret": secret },
    });
}
