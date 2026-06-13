"""WebSocket connection manager for CrowSync real-time events."""

import asyncio
import json
import logging
from datetime import datetime, timezone
from fastapi import WebSocket

logger = logging.getLogger("crowsync.websocket")


class WebSocketManager:
    def __init__(self):
        # project_id -> set of (websocket, member_id)
        self._connections: dict[int, set[tuple[WebSocket, int]]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, project_id: int, member_id: int, accept: bool = True):
        # accept=False when the caller already accepted the socket to read an auth
        # message first (WS auth lives in the first frame, not the query string — S2).
        if accept:
            await websocket.accept()
        async with self._lock:
            if project_id not in self._connections:
                self._connections[project_id] = set()
            self._connections[project_id].add((websocket, member_id))

    def disconnect(self, websocket: WebSocket, project_id: int, member_id: int):
        # Sync method: called from `finally` blocks where awaiting a lock
        # is awkward. Set ops are atomic in CPython, so this is safe enough.
        conns = self._connections.get(project_id)
        if conns:
            conns.discard((websocket, member_id))
            if not conns:
                self._connections.pop(project_id, None)

    async def broadcast(
        self, project_id: int, event: str, data: dict,
        exclude_member: int | None = None,
    ):
        """Send event to all connections in a project, optionally excluding sender."""
        async with self._lock:
            conns = self._connections.get(project_id)
            if not conns:
                return
            # Snapshot to avoid mutation during iteration
            targets = [(ws, mid) for ws, mid in conns if mid != exclude_member]

        if not targets:
            return

        message = json.dumps({
            "event": event,
            "data": data,
            "at": datetime.now(timezone.utc).isoformat(),
        })

        dead = []
        for ws, mid in targets:
            try:
                await ws.send_text(message)
            except Exception as e:
                logger.debug("WebSocket send failed for member %d: %s", mid, e)
                dead.append((ws, mid))

        if dead:
            async with self._lock:
                conns = self._connections.get(project_id)
                if conns:
                    for d in dead:
                        conns.discard(d)
                    if not conns:
                        self._connections.pop(project_id, None)

    def get_connection_count(self, project_id: int) -> int:
        return len(self._connections.get(project_id, set()))

    def get_total_connections(self) -> int:
        return sum(len(c) for c in self._connections.values())
