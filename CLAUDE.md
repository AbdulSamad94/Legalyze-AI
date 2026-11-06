# Legalyze AI

AI-powered legal document analyzer: users upload a contract/NDA/agreement, a multi-agent AI pipeline (FastAPI + OpenAI Agents SDK) summarizes it, flags risky clauses, and returns a safe/unsafe verdict, streamed to the browser over SSE. Auth, session, rate-limiting, and persistence live in the Next.js app; the FastAPI service is a stateless-ish analysis engine it calls over HTTP.

Full findings, evidence, and severity-ranked flaws: **see `AUDIT.md`** (last run 2026-07-05). Read it before assuming something works — several advertised features (guardrails, PDF/DOCX extraction, Redis session persistence) are currently dead code; details and exact file/line citations are there, not repeated here.

## Directory Map

**Frontend — `src/`** (Next.js 15 App Router, TS, Tailwind 4, Framer Motion)
- `app/` — routes. `document-analysis/` is the main authenticated dashboard (upload → processing → results, client-state-driven, no separate routes per step). `app/api/` — Next.js API routes; these are the only things allowed to talk to the FastAPI backend or the DB directly from user-facing code.
- `components/document-analysis/` — dashboard UI. `results/` subfolder holds the well-factored, internally-consistent Results view (header/stats/tabs/risk cards).
- `components/layout/` — homepage `Header.tsx`/`Footer.tsx`. Dashboard has its own `DesktopHeader.tsx` (in `document-analysis/`) — kept deliberately separate from the homepage header, not a duplicate to merge.
- `components/home/` — homepage sections (Hero, Features, Demo, etc.). `Demo.tsx` hits the **unauthenticated** `/api/demo` path.
- `lib/auth.ts` — better-auth server config (single source of truth for social linking, email verification, session policy). `lib/auth-server.ts` — `getSession()`/`requireAuth()` helpers, use these instead of re-reading cookies. `lib/auth-client.ts` — client-side better-auth hooks (`useSession`, `signIn`, etc.).
- `lib/db/` — Drizzle schema + client, targets Neon Postgres. `drizzle/migrations/0000_initial_schema.sql` is currently the only migration and matches the schema.
- `lib/services/analysisService.ts` — consumes the tee'd SSE stream from `/api/analyze` and persists the final result; not awaited in the route handler, but registered with `after()` so it survives the response finishing or the client disconnecting (up to the function's max duration).

**Backend — `backend/`** (FastAPI, Python ≥3.12, `uv`-managed)
- `app.py` — FastAPI app, CORS, startup/shutdown (model/cache/session init), health endpoints.
- `api.py` — the two real HTTP endpoints: `POST /demo/` (public, uncached) and `POST /analyze/` (used by the authenticated path, cached+retried). **Both currently decode any uploaded file as raw UTF-8 text** — see `AUDIT.md` C1 before changing upload handling.
- `core/` — `agent_factory.py` (builds `main_agent`, `analysis_agent`), `agent_definitions.py` (sub-agents: summarizer, risk detector, clause checker, document detector), `agent_prompts.py`, `guardrails.py` (defined but **not currently attached to any agent** — see `AUDIT.md` C2).
- `infrastructure/` — `model_manager.py` (OpenAI + OpenRouter model init), `cache_manager.py` (Redis, MD5-keyed result cache — actively used), `redis_session.py` (session storage — connected but **effectively unused**, see `AUDIT.md` M1).
- `services/analysis_pipeline.py` — `run_demo_pipeline` (simple, no cache/retry) and `run_enhanced_pipeline_streamed` (cache + `RetryHandler` + metrics) — both async generators yielding SSE-formatted strings.
- `utils/file_processor.py` — full PDF/DOCX/OCR text extraction, fully implemented, **currently dead code** (never called from `api.py`).

## Conventions

- Package manager is **pnpm** — don't reach for `npm`/`yarn` commands or lockfiles.
- All gradient CTAs use `bg-linear-to-r from-blue-600 to-indigo-600` — Tailwind v4's canonical gradient utility name (verified against `node_modules/tailwindcss/dist/lib.js` in this project: `bg-gradient-to-r` still compiles, since v4 keeps it as a backward-compat alias for `bg-linear-to-r`, but new code should use the canonical name).
- Step-progress UI (sidebar steps, mobile bottom nav) shares one visual language: gradient blue-to-indigo for "active", gradient green-to-emerald for "completed", `text-gray-500`/`bg-gray-200` (not `gray-400`) for "pending" — `gray-400` text fails WCAG AA contrast on white and was deliberately changed away from.
- Auth session reads on the server always go through `getSession()`/`requireAuth()` in `src/lib/auth-server.ts`. Client components use `authClient.useSession()` from `src/lib/auth-client.ts`, which returns `{ data, isPending, error }` — **not** `{ data, status }` (that's the old next-auth shape; don't reintroduce it).
- Real document analysis and the public demo are intentionally different code paths (`run_enhanced_pipeline_streamed` vs `run_demo_pipeline`) — don't assume unifying them is free; the demo path is deliberately unauthenticated and lighter-weight.

## Known Gotchas

- `next-auth`, `mongoose`, `gsap`, `locomotive-scroll`, `motion`, `bcryptjs` are still in `package.json` but have zero usages anywhere in `src/` — leftovers from a pre-migration stack (next-auth+Mongoose → better-auth+Drizzle/Postgres). Don't build on them; they're candidates for removal, not patterns to follow. `src/lib/utils/auth.ts` is similarly dead (Mongoose-flavored `sanitizeUser`, unused).
- `zod` **is** actually used (validators + `api-utils.ts`'s `ZodError` handling) — don't assume it's dead just because a naive grep for one quote style misses it.
- Uploading a `.pdf` or `.docx` today does not extract real text — see `AUDIT.md` C1. If you're debugging "weird" analysis results for non-`.txt` files, start there before assuming it's a prompt/model problem.
- `/api/demo` and `/api/report` have no auth and no rate limiting — don't assume request volume there is bounded the way `/api/analyze` is.
- Tests: frontend uses Vitest (`pnpm test`; files sit beside the code as `src/**/*.test.{ts,tsx}`, and component tests add a `// @vitest-environment jsdom` header). Backend uses pytest (`cd backend && uv run pytest`); `backend/tests/conftest.py` pins the environment so the suite stays offline, and `backend/tests/fakes.py` has a `FakeModel` for driving the real `Runner` without network calls.

For the full evidence trail behind every claim above (file/line citations, severity ranking, and the recommended fix order), see **`AUDIT.md`**.
