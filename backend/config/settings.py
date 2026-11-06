"""
Application configuration and environment variables.

Follows 12-factor app principles for environment-based config.
"""

from dataclasses import dataclass
import os
from dotenv import load_dotenv

load_dotenv()


@dataclass
class RedisConfig:
    """Redis connection configuration"""
    host: str = os.getenv("REDIS_HOST", "localhost")
    port: int = int(os.getenv("REDIS_PORT", 6379))
    password: str = os.getenv("REDIS_PASSWORD", "")
    ssl: bool = os.getenv("REDIS_USE_SSL", "true").lower() == "true"
    cache_ttl_seconds: int = 86400  # 24 hours

    @property
    def is_configured(self) -> bool:
        """Check if Redis is properly configured"""
        return bool(self.host)


@dataclass
class RateLimitConfig:
    """Rate limiting configuration for public/unauthenticated endpoints"""
    demo_max_requests: int = int(os.getenv("DEMO_RATE_LIMIT_MAX", 5))
    demo_window_seconds: int = int(os.getenv("DEMO_RATE_LIMIT_WINDOW_SECONDS", 3600))


@dataclass
class BackendAuthConfig:
    """Shared secret proving a request came from the Next.js server"""
    secret: str = os.getenv("BACKEND_API_SECRET", "")

    @property
    def is_configured(self) -> bool:
        """Check if the shared secret is set"""
        return bool(self.secret)


@dataclass
class OpenAIConfig:
    """OpenAI API configuration"""
    api_key: str = os.getenv("OPENAI_API_KEY", "")
    model: str = "gpt-4o-mini"
    temperature: float = 0.0
    top_p: float = 0.1
    max_tokens: int = 1000

    @property
    def is_configured(self) -> bool:
        """Check if OpenAI is properly configured"""
        return bool(self.api_key)


@dataclass
class OpenRouterConfig:
    """OpenRouter API configuration (for demo)"""
    api_key: str = os.getenv("OPEN_ROUTER_KEY", "")
    model: str = "qwen/qwen3-coder:free"
    base_url: str = "https://openrouter.ai/api/v1"

    @property
    def is_configured(self) -> bool:
        """Check if OpenRouter is properly configured"""
        return bool(self.api_key)


@dataclass
class AppConfig:
    """Main application configuration"""
    # Server
    host: str = "0.0.0.0"
    port: int = 8000
    debug: bool = os.getenv("DEBUG", "false").lower() == "true"

    # API
    api_title: str = "LegalyzeAI API"
    api_description: str = "AI-powered legal document analysis and risk assessment"
    api_version: str = "1.0.0"

    # Subsystems
    redis: RedisConfig = None
    rate_limit: RateLimitConfig = None
    backend_auth: BackendAuthConfig = None
    openai: OpenAIConfig = None
    openrouter: OpenRouterConfig = None

    def __post_init__(self):
        """Initialize subsystem configs"""
        if self.redis is None:
            self.redis = RedisConfig()
        if self.rate_limit is None:
            self.rate_limit = RateLimitConfig()
        if self.backend_auth is None:
            self.backend_auth = BackendAuthConfig()
        if self.openai is None:
            self.openai = OpenAIConfig()
        if self.openrouter is None:
            self.openrouter = OpenRouterConfig()

    def validate(self) -> list[str]:
        """Validate configuration and return list of issues"""
        issues = []

        if not self.openai.is_configured:
            issues.append("OPENAI_API_KEY not configured")
        if not self.openrouter.is_configured:
            issues.append("OPEN_ROUTER_KEY not configured")
        if not self.backend_auth.is_configured:
            issues.append("BACKEND_API_SECRET not configured (API routes will return 503)")
        if not self.redis.is_configured:
            issues.append("REDIS not configured (will run in degraded mode)")

        return issues


# Global config instance
settings = AppConfig()
