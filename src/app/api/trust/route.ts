import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const filePath = path.join(getDataDir(), "trust-scores.json");
    if (fs.existsSync(filePath)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    }
    return NextResponse.json({ scores: [], summary: { total: 0, trusted: 0, probation: 0, untrusted: 0, new: 0, avg_trust: 0 }, computed_at: null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
