import { z } from 'zod';

const SUPPORTED_LANGUAGES = ["en", "ur"] as const;

// Fits one full analysis: the analysis agent's 6144-token output cap is about
// 25k characters, plus the section markers added by buildCombinedText.
const MAX_TRANSLATE_TEXT_LENGTH = 30_000;

export const translateSchema = z.object({
    text: z.string().min(1, "Text is required").max(MAX_TRANSLATE_TEXT_LENGTH, "Text is too long"),
    source: z.enum(SUPPORTED_LANGUAGES).default("en"),
    target: z.enum(SUPPORTED_LANGUAGES).default("ur"),
});

export type TranslateInput = z.infer<typeof translateSchema>;
