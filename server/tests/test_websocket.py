"""Unit tests for WebSocketManager — no HTTP layer needed."""

import json
import pytest
from server.websocket_manager import WebSocketManager


class FakeWS:
    """Minimal WebSocket stand-in: records sent messages or raises on send."""

    def __init__(self, dead: bool = False):
        self.sent: list[str] = []
        self._dead = dead

    async def accept(self):
        pass

    async def send_text(self, message: str):
        if self._dead:
            raise RuntimeError("connection closed")
        self.sent.append(message)


# ── Connection lifecycle ──────────────────────────────────────────────────────

async def test_connect_increments_count():
    mgr = WebSocketManager()
    ws = FakeWS()
    await mgr.connect(ws, project_id=1, member_id=10)
    assert mgr.get_connection_count(1) == 1


async def test_disconnect_decrements_count():
    mgr = WebSocketManager()
    ws = FakeWS()
    await mgr.connect(ws, project_id=1, member_id=10)
    mgr.disconnect(ws, project_id=1, member_id=10)
    assert mgr.get_connection_count(1) == 0


async def test_disconnect_removes_project_key_when_empty():
    mgr = WebSocketManager()
    ws = FakeWS()
    await mgr.connect(ws, project_id=5, member_id=1)
    mgr.disconnect(ws, project_id=5, member_id=1)
    assert mgr.get_connection_count(5) == 0


async def test_get_total_connections_across_projects():
    mgr = WebSocketManager()
    for i in range(3):
        await mgr.connect(FakeWS(), project_id=1, member_id=i, accept=False)
    await mgr.connect(FakeWS(), project_id=2, member_id=99, accept=False)
    assert mgr.get_total_connections() == 4


# ── Broadcast ────────────────────────────────────────────────────────────────

async def test_broadcast_delivers_json_with_expected_fields():
    mgr = WebSocketManager()
    ws = FakeWS()
    await mgr.connect(ws, project_id=1, member_id=1, accept=False)
    await mgr.broadcast(1, "uploaded", {"path": "Assets/hero.fbx", "version": 2})
    assert len(ws.sent) == 1
    msg = json.loads(ws.sent[0])
    assert msg["event"] == "uploaded"
    assert msg["data"]["path"] == "Assets/hero.fbx"
    assert "at" in msg


async def test_broadcast_excludes_sender():
    mgr = WebSocketManager()
    sender = FakeWS()
    receiver = FakeWS()
    await mgr.connect(sender, project_id=1, member_id=1, accept=False)
    await mgr.connect(receiver, project_id=1, member_id=2, accept=False)
    await mgr.broadcast(1, "locked", {}, exclude_member=1)
    assert sender.sent == []
    assert len(receiver.sent) == 1


async def test_broadcast_removes_dead_connection_and_delivers_to_alive():
    mgr = WebSocketManager()
    dead = FakeWS(dead=True)
    alive = FakeWS()
    await mgr.connect(dead, project_id=1, member_id=1, accept=False)
    await mgr.connect(alive, project_id=1, member_id=2, accept=False)
    await mgr.broadcast(1, "ping", {})
    # Dead connection cleaned up, alive still present
    assert mgr.get_connection_count(1) == 1
    assert len(alive.sent) == 1


async def test_broadcast_to_empty_project_is_noop():
    mgr = WebSocketManager()
    # Should not raise
    await mgr.broadcast(999, "event", {"x": 1})
