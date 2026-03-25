import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { getDataDir } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = getDataDir();
  const files = ["signal-integrity.json", "trust-scores.json", "space-weather.json", "sentinel-state.json"];

  const status: Record<string, any> = { ok: true, service: "integrity-engine" };
  for (const f of files) {
    const p = path.join(dataDir, f);
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        status[f] = { exists: true, age_min: Math.round((Date.now() - stat.mtimeMs) / 60000) };
      } else {
        status[f] = { exists: false };
      }
    } catch {
      status[f] = { exists: false };
    }
  }

  return NextResponse.json(status);
}
