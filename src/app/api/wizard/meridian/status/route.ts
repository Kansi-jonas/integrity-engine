import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import fss from "fs";
import path from "path";
import { WIZARD_DATA_DIR } from "@/lib/wizard/data-dir";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const p = path.join(WIZARD_DATA_DIR, "meridian.json");
    if (fss.existsSync(p)) return NextResponse.json(JSON.parse(await fs.readFile(p, "utf-8")));
    return NextResponse.json({ enabled: false, atlasDir: "", configPath: "" });
  } catch { return NextResponse.json({ enabled: false }); }
}
export async function PATCH(request: NextRequest) {
  try {
    if (!fss.existsSync(WIZARD_DATA_DIR)) fss.mkdirSync(WIZARD_DATA_DIR, { recursive: true });
    const body = await request.json();
    const p = path.join(WIZARD_DATA_DIR, "meridian.json");
    let existing: any = {};
    try { if (fss.existsSync(p)) existing = JSON.parse(await fs.readFile(p, "utf-8")); } catch {}
    const merged = { ...existing, ...body };
    await fs.writeFile(p, JSON.stringify(merged, null, 2));
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
