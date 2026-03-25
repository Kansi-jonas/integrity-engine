import { NextResponse } from "next/server";
import { getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const filePath = path.join(getDataDir(), "shield-events.json");
    if (fs.existsSync(filePath)) {
      return NextResponse.json(JSON.parse(fs.readFileSync(filePath, "utf-8")));
    }
    return NextResponse.json({ events: [], last_run: null, summary: {} });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
