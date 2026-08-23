/** Local web dashboard for observing agent events. */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  EventBusClosedError,
  EventProjector,
  type AnyEventEnvelope,
  type EventBus,
} from "./events.ts";
import { DisplayPolicy } from "./ui/display-policy.ts";

export const DASHBOARD_HTML = `<!doctype html>
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
    let polling = false;
    const events = document.getElementById('events');
    const status = document.getElementById('status');
    function addEvent(event) {
      const empty = events.querySelector('.empty');
      if (empty) empty.remove();
      const card = document.createElement('section');
      card.className = 'event';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = \`#\${event.id}
\${new Date(event.timestamp).toLocaleTimeString()}\`;
      const body = document.createElement('div');
      const type = document.createElement('div');
      type.className = 'type';
      type.textContent = event.type;
      const payload = document.createElement('pre');
      payload.textContent = JSON.stringify(event.payload, null, 2);
      body.append(type, payload);
      card.append(meta, body);
      events.append(card);
      while (events.querySelectorAll('.event').length > 1000) {
        events.querySelector('.event').remove();
      }
      lastId = Math.max(lastId, event.id);
    }
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(\`/api/events?after=\${lastId}\`, {cache: 'no-store'});
        if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
        const data = await response.json();
        data.events.forEach(addEvent);
        status.textContent = '实时连接';
        status.style.color = '#86efac';
      } catch (error) {
        status.textContent = \`连接失败：\${error.message}\`;
        status.style.color = '#fca5a5';
      } finally {
        polling = false;
      }
    }
    poll();
    setInterval(poll, 500);
  </script>
</body>
</html>
`;

/** One entry in the dashboard's in-memory event sequence. */
export interface LoggedEvent {
  id: number;
  /** UTC ISO-8601 timestamp. */
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Envelope-shaped or plain-record input accepted by {@link EventLog.recordEvent}. */
export interface RecordableEvent {
  kind?: unknown;
  type?: unknown;
  payload?: unknown;
  event_id?: unknown;
  session_id?: unknown;
  task_id?: unknown;
  correlation_id?: unknown;
  sequence?: unknown;
}

export interface EventLogOptions {
  maxEvents?: number;
}

const METADATA_KEYS = [
  "event_id",
  "session_id",
  "task_id",
  "correlation_id",
  "sequence",
] as const;

/** An in-memory sequence of observable agent events. */
export class EventLog {
  private events: LoggedEvent[] = [];
  private readonly maxEvents: number;
  private nextId = 1;

  constructor(options: EventLogOptions = {}) {
    const maxEvents = options.maxEvents ?? 5_000;
    if (maxEvents <= 0) {
      throw new RangeError("maxEvents must be positive");
    }
    this.maxEvents = maxEvents;
  }

  record(type: string, payload: Record<string, unknown>): LoggedEvent {
    const event: LoggedEvent = {
      id: this.nextId,
      timestamp: new Date().toISOString(),
      type,
      payload: { ...payload },
    };
    this.nextId += 1;
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return { ...event };
  }

  /** Record an EventEnvelope, projected event, or plain event record. */
  recordEvent(event: RecordableEvent): LoggedEvent {
    const rawKind = event.kind ?? event.type ?? "event";
    const metadata: Record<string, unknown> = {};
    for (const key of METADATA_KEYS) {
      const value = event[key];
      if (value !== null && value !== undefined) {
        metadata[key] = value;
      }
    }
    // Enum-like kinds (with a ``value`` field) flatten to their value.
    const type =
      rawKind !== null && typeof rawKind === "object" && "value" in rawKind
        ? String((rawKind as { value: unknown }).value)
        : String(rawKind);
    const payload = event.payload;
    const safePayload =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>) }
        : {};
    return this.record(type, { ...metadata, ...safePayload });
  }

  read(afterId = 0): LoggedEvent[] {
    return this.events
      .filter((event) => event.id > afterId)
      .map((event) => ({ ...event }));
  }
}

/**
 * Feed the dashboard log from the event bus pull buffer. Resolves once the
 * bus is closed and its remaining buffered events have been drained.
 */
export async function consumePullBuffer(
  bus: EventBus,
  log: EventLog,
): Promise<void> {
  const projector = new EventProjector();
  const displayPolicy = new DisplayPolicy({ audience: "web" });
  for (;;) {
    let event: AnyEventEnvelope;
    try {
      event = await bus.get();
    } catch (error) {
      if (error instanceof EventBusClosedError) {
        return;
      }
      throw error;
    }
    const projected = projector.project(event, "web");
    for (const displayEvent of displayPolicy.project(projected)) {
      log.recordEvent({
        kind: displayEvent.kind,
        event_id: projected.event_id,
        session_id: projected.session_id,
        task_id: projected.task_id,
        correlation_id: displayEvent.correlationId,
        sequence: projected.sequence,
        payload: displayEvent.payload,
      });
    }
  }
}

function send(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  const data = Buffer.from(body, "utf-8");
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  response.end(data);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: Record<string, unknown>,
): void {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

/** ``int()``-style parse: optional sign, surrounding whitespace tolerated. */
function parseAfter(raw: string | null): number | null {
  const text = raw === null || raw === "" ? "0" : raw.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    return null;
  }
  return Number.parseInt(text, 10);
}

function createRequestHandler(eventLog: EventLog) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method !== "GET") {
      send(response, 501, "Unsupported method", "text/plain; charset=utf-8");
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(response, 200, DASHBOARD_HTML, "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/events") {
      const afterId = parseAfter(url.searchParams.get("after"));
      if (afterId === null) {
        sendJson(response, 400, { error: "after must be an integer" });
        return;
      }
      sendJson(response, 200, { events: eventLog.read(afterId) });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  };
}

export interface WebDashboardOptions {
  host?: string;
  port?: number;
}

/** Serve the live event dashboard on the local loopback interface. */
export class WebDashboard {
  private readonly server: Server;
  private readonly host: string;
  private readonly port: number;
  private listening = false;

  constructor(eventLog: EventLog, options: WebDashboardOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8765;
    this.server = createServer(createRequestHandler(eventLog));
  }

  get url(): string {
    const address = this.server.address();
    if (address !== null && typeof address === "object") {
      return `http://${address.address}:${address.port}/`;
    }
    return `http://${this.host}:${this.port}/`;
  }

  start(): Promise<void> {
    if (this.listening) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.listening = true;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.listening) {
      return Promise.resolve();
    }
    this.listening = false;
    return new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
      // Keep-alive clients (e.g. undici fetch) would otherwise delay close.
      this.server.closeIdleConnections();
    });
  }
}
