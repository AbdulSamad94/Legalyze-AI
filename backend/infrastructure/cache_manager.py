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
        """Connect to Redis cache, reusing the existing client if there is one"""
        if self.client:
            return True

        if not self.config.is_configured:
            return False

        client = redis.Redis(
            host=self.config.host,
            port=self.config.port,
            password=self.config.password,
            ssl=self.config.ssl,
            decode_responses=False
        )
        try:
            await client.ping()
        except Exception as e:
            print(f"[CACHE] Failed to connect: {e}")
            await self._close_quietly(client)
            return False

        # A concurrent request may have connected while this ping was pending.
        if self.client:
            await self._close_quietly(client)
        else:
            self.client = client
        return True

    async def _close_quietly(self, client: redis.Redis) -> None:
        """Close a discarded client; failing to close it must not fail the request"""
        try:
            await client.close()
        except Exception as e:
            print(f"[CACHE] Failed to close client: {e}")

    def _generate_key(self, document_text: str) -> str:
        """Generate cache key from document hash"""
        doc_hash = hashlib.md5(document_text.encode()).hexdigest()
        return f"analysis:{doc_hash}"

    async def get(self, document_text: str) -> Optional[Dict[str, Any]]:
        """Retrieve cached analysis"""
        if not self.client:
            return None

        try:
            key = self._generate_key(document_text)
            cached_data = await self.client.get(key)
            if cached_data:
                return json.loads(cached_data)
            return None
        except Exception as e:
            print(f"[CACHE] Read error: {e}")
            return None

    async def set(self, document_text: str, result: Dict[str, Any]) -> bool:
        """Cache analysis result"""
        if not self.client:
            return False

        try:
            key = self._generate_key(document_text)
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
        client, self.client = self.client, None
        if client:
            await client.close()


# Global cache instance
cache_manager = CacheManager()
