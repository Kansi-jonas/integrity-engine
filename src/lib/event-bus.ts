// ─── Event Bus ───────────────────────────────────────────────────────────────
// Singleton in-process event bus for real-time SSE streaming.
// Agents emit events after each run → SSE endpoint streams to connected clients.

import { EventEmitter } from "events";

export interface IntegrityEvent {
  type: "anomaly" | "interference" | "station_status" | "environment" | "fence_action" | "trust_change" | "zone_update";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  data?: any;
  timestamp: string;
}

class IntegrityEventBus extends EventEmitter {
  private recentEvents: IntegrityEvent[] = [];
  private readonly MAX_RECENT = 100;

  emit(event: string, ...args: any[]): boolean {
    if (event === "integrity" && args[0]) {
      const evt = args[0] as IntegrityEvent;
      evt.timestamp = evt.timestamp || new Date().toISOString();
      this.recentEvents.unshift(evt);
      if (this.recentEvents.length > this.MAX_RECENT) {
        this.recentEvents = this.recentEvents.slice(0, this.MAX_RECENT);
      }
    }
    return super.emit(event, ...args);
  }

  getRecent(limit = 20): IntegrityEvent[] {
    return this.recentEvents.slice(0, limit);
  }
}

// Singleton
export const eventBus = new IntegrityEventBus();
eventBus.setMaxListeners(50);
