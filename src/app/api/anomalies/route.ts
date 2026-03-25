import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

function sanitizeForPublic(data: any): any {
  const stationMap = new Map<string, string>();
  let counter = 1;
  function mapStation(name: string | null): string | null {
    if (!name) return null;
    if (!stationMap.has(name)) stationMap.set(name, `STN-${String(counter++).padStart(4, "0")}`);
    return stationMap.get(name)!;
  }
  function sanitizeText(text: string): string {
    return text
      .replace(/\b[A-Z0-9]{8,12}\b/g, (m) => mapStation(m) || m)
      .replace(/geodnet/gi, "network").replace(/onocoy/gi, "network")
      .replace(/NRBY_\w+/g, (m) => mapStation(m) || m)
      .replace(/ONO_\w+/g, (m) => mapStation(m) || m);
  }
  return {
    anomalies: (data.anomalies || []).map((a: any) => ({ ...a, station: mapStation(a.station), recommended_action: sanitizeText(a.recommended_action) })),
    integrity_scores: data.integrity_scores,
    stats: data.stats,
    station_timelines: (data.station_timelines || []).map((t: any) => ({ ...t, station: mapStation(t.station), network: "rtk_network" })),
    computed_at: data.computed_at,
  };
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const isPublic = url.searchParams.get("public") === "true";
    const filePath = path.join(getDataDir(), "signal-integrity.json");

    let data: any;
    if (fs.existsSync(filePath)) {
      try {
        data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {}
    }

    if (!data) {
      const { computeSignalIntegrity } = require("@/lib/signal-integrity");
      data = computeSignalIntegrity(getDb());
      try {
        const tmp = filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
      } catch {}
    }

    return NextResponse.json(isPublic ? sanitizeForPublic(data) : data);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
