// ─── Quality Prediction API ──────────────────────────────────────────────────
// GET /api/predict?lat=50&lon=10 — predict best station + expected fix rate
// GET /api/predict?lat=50&lon=10&station=STATION_NAME — predict for specific station

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const lat = parseFloat(url.searchParams.get("lat") || "0");
    const lon = parseFloat(url.searchParams.get("lon") || "0");
    const station = url.searchParams.get("station");

    if (lat === 0 && lon === 0) {
      return NextResponse.json({ error: "lat and lon parameters required" }, { status: 400 });
    }

    const db = getDb();
    const dataDir = getDataDir();

    if (station) {
      // Predict for specific station
      const { predictFixRate } = require("@/lib/ml/quality-predictor");
      const result = predictFixRate(db, dataDir, station, lat, lon);
      return NextResponse.json(result);
    } else {
      // Find best station for location
      const { predictForLocation } = require("@/lib/ml/quality-predictor");
      const result = predictForLocation(db, dataDir, lat, lon);
      return NextResponse.json(result);
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
