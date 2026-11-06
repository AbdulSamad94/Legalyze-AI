import { TranslateInput } from "@/lib/validators/translate";

interface TranslationResult {
    translatedText: string;
    method: "gemini" | "fallback";
}

interface GeminiResponse {
    candidates?: {
        content?: {
            parts?: {
                text?: string;
            }[];
        };
    }[];
}

export class TranslationService {
    private static FALLBACK_DICT: Record<string, string> = {
        Summary: "خلاصہ",
        "Risk Analysis": "خطرے کا تجزیہ",
        "Analysis Complete": "تجزیہ مکمل",
        "Document Summary": "دستاویز کا خلاصہ",
        "AI Verdict": "AI فیصلہ",
        Recommendation: "تجویز",
        Critical: "انتہائی اہم",
        High: "زیادہ",
        Medium: "درمیانہ",
        Low: "کم",
        Unknown: "نامعلوم",
        contract: "معاہدہ",
        agreement: "رضامندی",
        clause: "شق",
        liability: "ذمہ داری",
        terms: "شرائط",
        conditions: "حالات",
        breach: "خلاف ورزی",
        violation: "نقض",
        penalty: "سزا",
        damages: "نقصانات",
        compensation: "معاوضہ",
        legal: "قانونی",
        document: "دستاویز",
        review: "جائزہ",
        analysis: "تجزیہ",
        "The document": "دستاویز",
        "This agreement": "یہ معاہدہ",
        "shall be": "ہوگا",
        "may be": "ہو سکتا ہے",
        "must be": "ہونا چاہیے",
        "should be": "ہونا چاہیے",
    };

    /**
     * Main entry point to translate text.
     * Tries Gemini -> Local Fallback.
     */
    static async translate(data: TranslateInput): Promise<TranslationResult> {
        const { text, source, target } = data;

        // 1. Try Gemini
        const geminiResult = await this.tryGeminiTranslate(text, source, target);
        if (geminiResult) {
            return { translatedText: geminiResult, method: "gemini" };
        }

        // 2. Fallback
        const fallbackResult = this.getFallbackTranslation(text);
        return { translatedText: fallbackResult, method: "fallback" };
    }

    private static getFallbackTranslation(text: string): string {
        let out = text;
        for (const [en, ur] of Object.entries(this.FALLBACK_DICT)) {
            const escaped = en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(`\\b${escaped}\\b`, "gi");
            out = out.replace(regex, ur);
        }
        return out;
    }

    private static async tryGeminiTranslate(text: string, source: string, target: string): Promise<string | null> {
        const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_API_KEY;
        if (!apiKey) return null;

        const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
        const prompt = `Translate the following text from ${source} to ${target}. Only output the translated text. Preserve paragraph breaks, lists, and special markers like __VERDICT__ or __RSTART__ exactly as-is.\n\n"""${text}"""`;

        const body = {
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: Math.min(65500, Math.max(1024, Math.ceil(text.length / 1.5))),
                temperature: 0.0,
            },
        };

        try {
            const res = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30000),
            });

            if (!res.ok) return null;

            const raw = await res.json();
            return this.extractGeminiText(raw) || null;
        } catch {
            return null;
        }
    }

    private static extractGeminiText(parsed: unknown): string | undefined {
        if (!parsed || typeof parsed !== 'object') return undefined;
        // Simple extraction logic for brevity based on known Gemini response structure
        const p = parsed as GeminiResponse;
        return p?.candidates?.[0]?.content?.parts?.[0]?.text;
    }
}
