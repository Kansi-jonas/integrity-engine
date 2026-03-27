import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = getDataDir();
  try {
    const fp = path.join(dataDir, "network-health.json");
    if (fs.existsSync(fp)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(fp, "utf-8")));
    }
    // Compute on-demand if not cached
    const db = getDb();
    const { computeNetworkHealth } = require("@/lib/network-health");
    const health = computeNetworkHealth(db, dataDir);
    return NextResponse.json(health);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
