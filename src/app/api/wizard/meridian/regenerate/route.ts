import { NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
export const dynamic = "force-dynamic";
export async function POST() {
  try {
    const { generateIntegrityZones } = require("@/lib/wizard/zone-generator");
    const db = getDb();
    const zones = generateIntegrityZones(db, getDataDir());
    return NextResponse.json({ ok: true, zones_generated: zones.length });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
