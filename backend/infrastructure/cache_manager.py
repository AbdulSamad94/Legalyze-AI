"""Cache management for analysis results."""

import hashlib
import json
from typing import Optional, Dict, Any
import redis.asyncio as redis
from config import settings


class CacheManager:
    """Manages caching of analysis results in Redis"""

    def __init__(self):
        """Initialize cache manager"""
        self.config = settings.redis
        self.client: Optional[redis.Redis] = None

    async def connect(self) -> bool:
        """Connect to Redis cache"""
        if not self.config.is_configured:
            return False

        try:
            self.client = redis.Redis(
                host=self.config.host,
                port=self.config.port,
                password=self.config.password,
                ssl=self.config.ssl,
                decode_responses=False
            )
            await self.client.ping()
            return True
        except Exception as e:
            print(f"[CACHE] Failed to connect: {e}")
            return False

    def _generate_key(self, document_text: str, version: str) -> str:
        """Generate cache key from the analysis version and document hash"""
        doc_hash = hashlib.sha256(document_text.encode()).hexdigest()
        return f"analysis:{version}:{doc_hash}"

    async def get(self, document_text: str, version: str) -> Optional[Dict[str, Any]]:
        """Retrieve cached analysis"""
        if not self.client:
            return None

        try:
            key = self._generate_key(document_text, version)
            cached_data = await self.client.get(key)
            if cached_data:
                return json.loads(cached_data)
            return None
        except Exception as e:
            print(f"[CACHE] Read error: {e}")
            return None

    async def set(self, document_text: str, version: str, result: Dict[str, Any]) -> bool:
        """Cache analysis result"""
        if not self.client:
            return False

        try:
            key = self._generate_key(document_text, version)
            await self.client.set(
                key,
                json.dumps(result, default=str),
                ex=self.config.cache_ttl_seconds
            )
            return True
        except Exception as e:
            print(f"[CACHE] Write error: {e}")
            return False

    async def close(self):
        """Close cache connection"""
        if self.client:
            await self.client.close()


# Global cache instance
cache_manager = CacheManager()
