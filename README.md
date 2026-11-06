# Legalyze AI

**Legalyze AI** is an AI-powered legal document analyzer. Upload a contract, NDA, or agreement, and a multi-agent AI pipeline summarizes it, flags risky clauses, and returns a safe/unsafe verdict — streamed to the browser in real time.

## Features

- **AI Legal Summaries** — clear, concise summaries of complex legal documents
- **Risk Detection** — flags risky clauses that may need negotiation
- **Safe/Unsafe Verdict** — a clear verdict based on detected risks
- **Real-time streaming analysis** — progress and results stream in over SSE, not a spinner-and-wait
- **Public demo** — try it without an account, rate-limited to keep costs bounded
- **Authenticated dashboard** — save, browse, export, and delete past analyses

## Tech Stack

This is a two-service app: a Next.js frontend/app-server and a separately-deployed FastAPI analysis backend.

- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS 4, Framer Motion
- **Auth**: [better-auth](https://www.better-auth.com/) (email/password + Google/GitHub OAuth)
- **Database**: Drizzle ORM targeting Neon (serverless Postgres)
- **Backend**: FastAPI + OpenAI Agents SDK — see [`backend/README.md`](./backend/README.md)
- **AI Models**: OpenAI (GPT-4o-mini) for full analysis, OpenRouter (Qwen) for the public demo
- **Package manager**: pnpm (frontend), uv (backend)
- **Deployment**: Vercel (frontend), FastAPI Cloud (backend)

## Project Structure

```
├── src/                    # Next.js app (see CLAUDE.md for the full directory map)
│   ├── app/                 # routes, incl. app/api/* — the only code allowed to talk to the DB or backend directly
│   ├── components/          # UI, split by page/domain
│   └── lib/                 # auth (better-auth), db (Drizzle), services, utils
├── drizzle/                 # DB schema migrations
├── backend/                 # FastAPI analysis service — deployed independently, see backend/README.md
└── public/                  # static assets
```

## Getting Started

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io/)
- A Postgres database (this project targets [Neon](https://neon.tech/))
- The backend service running — either locally (see [`backend/README.md`](./backend/README.md)) or pointed at a deployed instance

### Install

```bash
pnpm install
```

### Environment Variables

Create a `.env` in the project root:

```env
# Database
DATABASE_URL="postgresql://..."

# better-auth
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="..."
GOOGLE_CLIENT_ID="..."
GOOGLE_CLIENT_SECRET="..."
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."

# FastAPI backend
WEB_URL="http://127.0.0.1:8000"   # or your deployed FastAPI Cloud URL
# Shared secret sent to the backend. Server-side only, never NEXT_PUBLIC_.
# Must equal BACKEND_API_SECRET on the backend. Generate: openssl rand -hex 32
BACKEND_API_SECRET="..."

# Bug report emails (src/app/api/report/route.ts)
SMTP_HOST="..."
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASS="..."
SMTP_FROM="..."
TO_EMAIL="..."

# Optional — Google Analytics
NEXT_PUBLIC_GA_ID=""
```

### Tests

```bash
pnpm test                    # frontend (Vitest)
cd backend && uv run pytest  # backend (pytest, runs offline)
```

### Database migrations

```bash
npx drizzle-kit generate   # generate a migration from schema changes
npx drizzle-kit migrate    # apply migrations
```

### Run the dev server

```bash
pnpm dev
```

Runs on [http://localhost:3000](http://localhost:3000). Make sure the backend (`backend/`) is running too — the frontend calls it directly for all analysis requests.

## Deployment

- **Frontend**: Vercel — live at `legalyze-ai.vercel.app`
- **Backend**: FastAPI Cloud — see [`backend/README.md`](./backend/README.md) for deployment details

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the **MIT License**.
