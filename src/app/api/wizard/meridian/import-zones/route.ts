import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function POST() {
  return NextResponse.json({ ok: true, imported: 0, message: "MERIDIAN import — use Zone Generator V2 instead" });
}
