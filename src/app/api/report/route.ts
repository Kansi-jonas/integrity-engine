import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = getDataDir();
  try {
    const fp = path.join(dataDir, "daily-report.json");
    if (fs.existsSync(fp)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(fp, "utf-8")));
    }
    // Generate on-demand
    const db = getDb();
    const { generateDailyReport } = require("@/lib/daily-report");
    const report = generateDailyReport(db, dataDir);
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
