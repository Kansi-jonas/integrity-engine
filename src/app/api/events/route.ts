// ─── SSE Endpoint ────────────────────────────────────────────────────────────
// Server-Sent Events for real-time integrity alerts.
// Clients connect via EventSource and receive live updates from all agents.
//
// Usage: const es = new EventSource("/api/events");
//        es.onmessage = (e) => console.log(JSON.parse(e.data));

import { eventBus, IntegrityEvent } from "@/lib/event-bus";

export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send recent events as initial batch
      const recent = eventBus.getRecent(10);
      for (const evt of recent.reverse()) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }

      // Send keepalive comment
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive ${Date.now()}\n\n`));
        } catch {
          clearInterval(keepalive);
        }
      }, 30000);

      // Listen for new events
      const onEvent = (evt: IntegrityEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
        } catch {
          // Client disconnected
          eventBus.off("integrity", onEvent);
          clearInterval(keepalive);
        }
      };

      eventBus.on("integrity", onEvent);

      // Cleanup on close (AbortController not available in all runtimes)
      // The try/catch in onEvent handles disconnection gracefully
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
