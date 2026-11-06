# Legalyze AI — Backend

FastAPI service that powers document analysis for [Legalyze AI](../README.md). It's a stateless-ish analysis engine: the Next.js app owns auth, sessions, rate-limiting policy, and persistence, and calls this service over HTTP for the actual AI work.

## Overview

Built with a modular **multi-agent architecture** on top of the OpenAI Agents SDK, this service:

- Detects whether an upload is a legal document worth analyzing
- Extracts real text from `.txt`, `.pdf`, and `.docx` uploads (`utils/file_processor.py`)
- Summarizes the document, flags risky clauses, and returns a safe/unsafe verdict
- Caches results in Redis (keyed by document hash) so identical documents skip the LLM
- Rate-limits the public demo endpoint per-IP via Redis

---

## Project Setup

### Prerequisites

- Python ≥ 3.12
- [`uv`](https://github.com/astral-sh/uv) (fast Python package/dependency manager)

Install `uv` if you don't have it:

```bash
# Linux/macOS:
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell):
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

### Installation

```bash
cd backend
uv sync
```

`uv sync` reads `pyproject.toml`/`uv.lock` and creates `.venv` with all dependencies pinned — no `requirements.txt` involved.

### Environment Variables

Create a `.env` file in `backend/`:

```env
# Required — main analysis pipeline
OPENAI_API_KEY="sk-..."

# Required — powers the public /demo/ endpoint
OPEN_ROUTER_KEY="sk-or-..."

# Required — shared secret the Next.js server sends as X-Internal-Secret. Must
# equal BACKEND_API_SECRET in the Next.js app. If unset, /demo/ and /analyze/
# return 503. Generate: openssl rand -hex 32
BACKEND_API_SECRET="..."

# Optional — result caching + demo rate limiting. If unset, the app runs in
# degraded mode: no caching, and the demo endpoint is unthrottled.
REDIS_HOST="localhost"
REDIS_PORT=6379
REDIS_PASSWORD=""
REDIS_USE_SSL=true

# Optional — demo rate limit (defaults shown)
DEMO_RATE_LIMIT_MAX=5
DEMO_RATE_LIMIT_WINDOW_SECONDS=3600

# Optional
DEBUG=false
```

`.env` is already in `.gitignore` — don't commit it.

---

## How to Run

```bash
# Dev server with auto-reload
uv run uvicorn app:app --reload --port 8000

# Or directly (uses host/port from config/settings.py)
uv run python app.py
```

- `GET /` — service info
- `GET /health` — reports cache/rate-limiter connection status and model init state
- `POST /demo/` — backs the frontend's public demo; rate-limited per visitor IP, no caching or retries (`run_demo_pipeline`)
- `POST /analyze/` — used by the authenticated frontend flow; adds Redis caching and retry logic (`run_enhanced_pipeline_streamed`)

Both `POST` endpoints require the `X-Internal-Secret` header (401 if missing or wrong, 503 if `BACKEND_API_SECRET` isn't set on the server) and stream results back as Server-Sent Events. `GET /` and `GET /health` stay public.

---

## Deployment

This service is deployed to **[FastAPI Cloud](https://fastapicloud.com)**. The `.fastapicloud/` folder (created by linking this directory to a FastAPI Cloud project) holds your local project link and is git-ignored — it's regenerated per-machine, not something to commit or share.

Point the frontend at this service by setting `WEB_URL` (in the Next.js app's environment) to this backend's deployed URL.

---

## Project Flow Diagram

```mermaid
graph TD
    A["User Input"] --> B["Input Guardrail Check"]
    B --> C{"Contains Sensitive Info?"}
    C -- Yes --> D["Block Request"]
    C -- No --> E["MainAgent - Decision Router"]
    E --> F["DocumentDetectorAgent Tool"]
    F --> G{"Input Type?"}
    G -- Legal Document --> H["Analysis-Agent"]
    G -- Casual Chat --> I["CasualChatAgent"]
    G -- Unclear --> J["Default Response"]
    H --> K["Input Guardrail Check"]
    K --> L{"Sensitive Info?"}
    L -- Yes --> M["Block Analysis"]
    L -- No --> N["Start Analysis Workflow"]
    N --> O["SummarizerAgent Tool"]
    O --> P["Wait for Summary"]
    P --> Q["RiskDetectorAgent Tool"]
    Q --> R["Wait for Risk Analysis"]
    R --> S["ClauseCheckerAgent Tool"]
    S --> T["Wait for Clause Check"]
    T --> U["Combine Results"]
    U --> V["Output Guardrail Check"]
    V --> W{"Output Valid?"}
    W -- No --> X["Trigger Error"]
    W -- Yes --> Y["FriendlyAgent"]
    Y --> Z["Format Response"]
    Z --> AA["Output Guardrail Check"]
    AA --> BB{"Response Valid?"}
    BB -- No --> CC["Trigger Error"]
    BB -- Yes --> DD["Final Response"]
    I --> EE["Generate Chat Response"]
    EE --> FF["Output Guardrail Check"]
    FF --> GG{"Response Valid?"}
    GG -- No --> HH["Trigger Error"]
    GG -- Yes --> II["Chat Response"]
    J --> JJ["Default Message"]
    D --> KK["Error Message"]
    M --> KK
    X --> KK
    CC --> KK
    HH --> KK
    DD --> LL["User Sees Legal Analysis"]
    II --> MM["User Sees Chat Response"]
    JJ --> NN["User Sees Default Message"]
    KK --> OO["User Sees Error"]
     B:::guardrail
     C:::decision
     D:::error
     E:::agent
     G:::decision
     H:::agent
     I:::agent
     K:::guardrail
     L:::decision
     M:::error
     O:::agent
     Q:::agent
     S:::agent
     V:::guardrail
     W:::decision
     X:::error
     Y:::agent
     AA:::guardrail
     BB:::decision
     CC:::error
     DD:::output
     FF:::guardrail
     GG:::decision
     HH:::error
     II:::output
     JJ:::output
     KK:::error
    classDef agent fill:#e3f2fd,stroke:#1565c0,color:#000,font-weight:bold,stroke-width:2px
    classDef guardrail fill:#fff8e1,stroke:#ff8f00,color:#000,font-weight:bold,stroke-width:2px
    classDef decision fill:#ede7f6,stroke:#6a1b9a,color:#000,font-weight:bold,stroke-width:2px
    classDef output fill:#e8f5e9,stroke:#2e7d32,color:#000,font-weight:bold,stroke-width:2px
    classDef error fill:#ffebee,stroke:#c62828,color:#000,font-weight:bold,stroke-width:2px
```

> **Note:** the guardrail stages shown above (`sensitive_input_guardrail`, `final_output_validation_guardrail`, both defined in `core/guardrails.py`) are implemented but not yet attached to `main_agent`/`analysis_agent` in `core/agent_factory.py` — this diagram documents the intended flow, not the currently-running one. Tracked as a known gap, not fixed in this pass.

---

## Flow Explanation

### 1. Input Guardrail (planned — see note above)

Scans input for sensitive data. If found → **blocked**.

### 2. Main Agent — Decision Router

Routes input to the right agent (document analysis vs. casual chat) using `DocumentDetectorAgent`.

### 3. Legal Document Flow

- Runs `SummarizerAgent`, `RiskDetectorAgent`, `ClauseCheckerAgent` as tools of `analysis_agent`
- Combines results into a `FinalOutput` (summary, risks, verdict, disclaimer)

### 4. Casual Chat Flow

- Handled by `main_agent` directly when the input isn't a document

### 5. Errors

- Unsupported/corrupt uploads are rejected fast (400) before any LLM call — see `_extract_text_or_400` in `api.py`
- Pipeline failures return a friendly error message over the SSE stream rather than a raw exception
