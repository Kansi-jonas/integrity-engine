import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataDir = getDataDir();
    const ziPath = path.join(dataDir, "zone-integrity.json");
    if (fs.existsSync(ziPath)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(ziPath, "utf-8")));
    }
    return NextResponse.json({ zones: [], computed_at: null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
