"""Local web dashboard for observing agent events."""

from __future__ import annotations

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from threading import Lock, Thread
from typing import Any
from urllib.parse import parse_qs, urlparse


DASHBOARD_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>laoHuangCode Trace</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 0; background: #0b1020; color: #dbeafe; }
    header { position: sticky; top: 0; padding: 18px 24px; background: #11182d;
      border-bottom: 1px solid #263450; display: flex; justify-content: space-between; }
    h1 { margin: 0; font: 650 18px/1.4 system-ui, sans-serif; }
    #status { color: #86efac; font: 13px system-ui, sans-serif; }
    main { max-width: 1050px; margin: 0 auto; padding: 20px; }
    .empty { color: #8190ad; text-align: center; padding: 80px 0; }
    .event { display: grid; grid-template-columns: 150px 1fr; gap: 16px; margin: 10px 0;
      padding: 14px 16px; background: #11182d; border: 1px solid #263450; border-radius: 10px; }
    .meta { color: #93c5fd; font-size: 12px; }
    .type { color: #fbbf24; font-weight: 700; margin-bottom: 6px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #d1d5db; }
    @media (max-width: 650px) { .event { grid-template-columns: 1fr; gap: 8px; } }
  </style>
</head>
<body>
  <header><h1>laoHuangCode · Agent Trace</h1><span id="status">连接中</span></header>
  <main id="events"><div class="empty">等待 Agent 事件…</div></main>
  <script>
    let lastId = 0;
    const events = document.getElementById('events');
    const status = document.getElementById('status');
    function addEvent(event) {
      const empty = events.querySelector('.empty');
      if (empty) empty.remove();
      const card = document.createElement('section');
      card.className = 'event';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `#${event.id}\n${new Date(event.timestamp).toLocaleTimeString()}`;
      const body = document.createElement('div');
      const type = document.createElement('div');
      type.className = 'type';
      type.textContent = event.type;
      const payload = document.createElement('pre');
      payload.textContent = JSON.stringify(event.payload, null, 2);
      body.append(type, payload);
      card.append(meta, body);
      events.append(card);
      lastId = Math.max(lastId, event.id);
    }
    async function poll() {
      try {
        const response = await fetch(`/api/events?after=${lastId}`, {cache: 'no-store'});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        data.events.forEach(addEvent);
        status.textContent = '实时连接';
        status.style.color = '#86efac';
      } catch (error) {
        status.textContent = `连接失败：${error.message}`;
        status.style.color = '#fca5a5';
      }
    }
    poll();
    setInterval(poll, 500);
  </script>
</body>
</html>
"""


class EventLog:
    """A thread-safe, in-memory sequence of observable agent events."""

    def __init__(self) -> None:
        self._events: list[dict[str, Any]] = []
        self._next_id = 1
        self._lock = Lock()

    def record(
        self, event_type: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        with self._lock:
            event = {
                "id": self._next_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": event_type,
                "payload": dict(payload),
            }
            self._next_id += 1
            self._events.append(event)
            return dict(event)

    def read(self, *, after_id: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(event) for event in self._events if event["id"] > after_id]


def _handler_for(event_log: EventLog) -> type[BaseHTTPRequestHandler]:
    class DashboardHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path in ("/", "/index.html"):
                self._send(200, DASHBOARD_HTML.encode("utf-8"), "text/html; charset=utf-8")
                return

            if parsed.path == "/api/events":
                try:
                    after_id = int(parse_qs(parsed.query).get("after", ["0"])[0])
                except ValueError:
                    self._send_json(400, {"error": "after must be an integer"})
                    return
                self._send_json(200, {"events": event_log.read(after_id=after_id)})
                return

            self._send_json(404, {"error": "not found"})

        def _send_json(self, status: int, value: dict[str, Any]) -> None:
            self._send(
                status,
                json.dumps(value, ensure_ascii=False).encode("utf-8"),
                "application/json; charset=utf-8",
            )

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return DashboardHandler


class WebDashboard:
    """Serve the live event dashboard on a local background thread."""

    def __init__(
        self,
        event_log: EventLog,
        *,
        host: str = "127.0.0.1",
        port: int = 8765,
    ) -> None:
        self._server = ThreadingHTTPServer((host, port), _handler_for(event_log))
        self._thread: Thread | None = None

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/"

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = Thread(
            target=self._server.serve_forever,
            name="laohuangcode-web",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        if self._thread is None:
            return
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)
        self._thread = None
