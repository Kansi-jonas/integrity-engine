// ─── Protection Level API ────────────────────────────────────────────────────
// GET /api/protection-level?lat=50.0&lon=10.0&tier=machine_control
// Returns HPL, VPL, integrity risk, and station breakdown for any coordinate.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get("lat") || "0");
    const lon = parseFloat(url.searchParams.get("lon") || "0");
    const tier = (url.searchParams.get("tier") || "machine_control") as any;

    if (lat === 0 && lon === 0) {
      return NextResponse.json({ error: "lat and lon parameters required" }, { status: 400 });
    }

    const { computeProtectionLevel } = require("@/lib/protection-level");
    const db = getDb();
    const result = computeProtectionLevel(db, lat, lon, getDataDir(), tier);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
