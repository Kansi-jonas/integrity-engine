// ─── Quality Forecast API ────────────────────────────────────────────────────
// GET /api/forecast?lat=52.5&lon=13.4&hours=1,6,24
//
// Returns predicted fix rate, HPL/VPL confidence bands, and factors
// that will affect quality at the specified horizons.
//
// This is the monetizable Enterprise endpoint.

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import { generateForecast } from "@/lib/forecast/quality-forecast";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const lat = parseFloat(searchParams.get("lat") || "");
  const lon = parseFloat(searchParams.get("lon") || "");
  const hoursParam = searchParams.get("hours") || "1,6,24";

  if (isNaN(lat) || isNaN(lon)) {
    return NextResponse.json(
      { error: "Missing required parameters: lat, lon" },
      { status: 400 }
    );
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json(
      { error: "Invalid coordinates" },
      { status: 400 }
    );
  }

  const hours = hoursParam.split(",").map(h => parseFloat(h.trim())).filter(h => !isNaN(h) && h > 0 && h <= 72);
  if (hours.length === 0) hours.push(1, 6, 24);

  try {
    const db = getDb();
    const dataDir = getDataDir();
    const forecast = generateForecast(lat, lon, hours, db, dataDir);

    // Add public-safe sanitization if requested
    const isPublic = searchParams.get("public") === "true";
    if (isPublic) {
      // Remove internal details for customer-facing API
      forecast.forecast = forecast.forecast.map(f => ({
        ...f,
        constellation_alerts: [], // Don't expose constellation details
      }));
    }

    return NextResponse.json(forecast);
  } catch (error) {
    return NextResponse.json(
      { error: "Forecast generation failed" },
      { status: 500 }
    );
  }
}
