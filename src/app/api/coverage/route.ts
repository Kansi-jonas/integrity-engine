// ─── Coverage Optimizer API ──────────────────────────────────────────────────
// GET /api/coverage — coverage health report with improvement actions

import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataDir = getDataDir();
    const filePath = path.join(dataDir, "coverage-optimizer.json");

    if (fs.existsSync(filePath)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    }

    return NextResponse.json({
      total_cells: 0, green_cells: 0, yellow_cells: 0, orange_cells: 0, red_cells: 0,
      green_percentage: 0, improvement_actions: [],
      trend: { green_pct_7d_ago: null, green_pct_now: 0, improving: false },
      computed_at: null,
      message: "Coverage optimizer has not run yet. Trigger the quality pipeline.",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
