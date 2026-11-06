"""Shared pytest setup.

The environment is pinned here, before any application module is imported,
because `config.settings` reads os.environ at import time and `load_dotenv()`
does not override variables that are already set. This keeps the suite offline
and independent of a developer's real keys in backend/.env.
"""

import os

os.environ["OPENAI_API_KEY"] = ""
os.environ["OPEN_ROUTER_KEY"] = ""
os.environ["REDIS_HOST"] = ""
os.environ["OPENAI_AGENTS_DISABLE_TRACING"] = "1"
