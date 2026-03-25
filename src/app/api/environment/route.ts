// ─── Environment API ─────────────────────────────────────────────────────────
// GET /api/environment — Full environmental data (ionosphere, troposphere,
// constellation health, CME forecasts, tides)

import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const filePath = path.join(getDataDir(), "environment.json");
    if (fs.existsSync(filePath)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    }
    // Fetch live if no cache
    const { fetchEnvironment } = require("@/lib/agents/environment");
    const data = await fetchEnvironment(getDataDir());
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
