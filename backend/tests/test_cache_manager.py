"""CacheManager connection lifecycle, with the Redis client as the only fake."""

import asyncio

import pytest
import redis.asyncio as redis

from config.settings import RedisConfig
from infrastructure.cache_manager import CacheManager, cache_manager
from services.analysis_pipeline import run_enhanced_pipeline_streamed


class FakeRedis:
    def __init__(self, ping_error=None, ping_gate=None):
        self.ping_error = ping_error
        self.ping_gate = ping_gate
        self.close_calls = 0

    async def ping(self):
        if self.ping_gate:
            await self.ping_gate.wait()
        if self.ping_error:
            raise self.ping_error
        return True

    async def close(self):
        self.close_calls += 1


@pytest.fixture
def built(monkeypatch):
    """Records each client built; tests queue ping behaviour in `built.scripts`."""

    class Built(list):
        scripts: list[dict]

    clients = Built()
    clients.scripts = []

    def build(**_kwargs):
        script = clients.scripts.pop(0) if clients.scripts else {}
        client = FakeRedis(**script)
        clients.append(client)
        return client

    monkeypatch.setattr(redis, "Redis", build)
    return clients


@pytest.fixture
def manager():
    cache = CacheManager()
    cache.config = RedisConfig(host="redis.test")
    return cache


async def test_second_connect_reuses_the_live_client(manager, built):
    assert await manager.connect() is True
    first = manager.client

    assert await manager.connect() is True

    assert len(built) == 1
    assert manager.client is first
    assert first.close_calls == 0


async def test_failed_ping_closes_the_client_and_leaves_none(manager, built):
    built.scripts.append({"ping_error": ConnectionError("down")})

    assert await manager.connect() is False

    assert manager.client is None
    assert built[0].close_calls == 1


async def test_failure_closing_a_failed_client_still_reports_disconnected(manager, built, monkeypatch):
    async def broken_close(self):
        raise ConnectionError("still down")

    monkeypatch.setattr(FakeRedis, "close", broken_close)
    built.scripts.append({"ping_error": ConnectionError("down")})

    assert await manager.connect() is False
    assert manager.client is None


async def test_connect_after_a_failure_retries_and_recovers(manager, built):
    built.scripts.append({"ping_error": ConnectionError("down")})
    await manager.connect()

    assert await manager.connect() is True

    assert len(built) == 2
    assert manager.client is built[1]


async def test_close_then_connect_builds_a_new_client(manager, built):
    await manager.connect()

    await manager.close()

    assert manager.client is None
    assert built[0].close_calls == 1

    assert await manager.connect() is True
    assert len(built) == 2
    assert manager.client is built[1]


async def test_close_twice_closes_the_client_once(manager, built):
    await manager.connect()

    await manager.close()
    await manager.close()

    assert built[0].close_calls == 1


async def test_unconfigured_redis_builds_nothing(built):
    cache = CacheManager()
    cache.config = RedisConfig(host="")

    assert await cache.connect() is False

    assert built == []
    assert cache.client is None


async def test_two_pipeline_runs_share_one_client(built, monkeypatch):
    monkeypatch.setattr(cache_manager, "config", RedisConfig(host="redis.test"))
    monkeypatch.setattr(cache_manager, "client", None)

    for session_id in ("first", "second"):
        run = run_enhanced_pipeline_streamed("Some contract.", "contract.txt", session_id)
        await anext(run)
        await run.aclose()

    assert len(built) == 1


async def test_concurrent_connects_keep_one_client_and_close_the_other(manager, built):
    gate = asyncio.Event()
    built.scripts.extend([{"ping_gate": gate}, {"ping_gate": gate}])

    pending = asyncio.gather(manager.connect(), manager.connect())
    await asyncio.sleep(0)
    gate.set()

    assert await pending == [True, True]
    assert len(built) == 2
    open_clients = [client for client in built if client.close_calls == 0]
    assert open_clients == [manager.client]
