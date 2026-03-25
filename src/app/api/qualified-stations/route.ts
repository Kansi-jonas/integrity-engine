// ─── Qualified Stations API ──────────────────────────────────────────────────
// GET /api/qualified-stations
// Returns the filtered, quality-assured station list for Alberding config.
// Only stations that pass ALL quality gates.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const dataDir = getDataDir();
    const url = new URL(request.url);
    const forceRecompute = url.searchParams.get("recompute") === "true";

    const filePath = path.join(dataDir, "qualified-stations.json");

    // Try cached unless force recompute
    if (!forceRecompute && fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const ageH = (Date.now() - stat.mtimeMs) / 3600000;
        if (ageH < 5) {
          return NextResponse.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
        }
      } catch {}
    }

    // Compute fresh
    const { generateQualifiedConfig } = require("@/lib/config-generator");
    const db = getDb();
    const result = generateQualifiedConfig(db, dataDir);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
