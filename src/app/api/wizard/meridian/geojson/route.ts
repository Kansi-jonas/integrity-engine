import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import fss from "fs";
import path from "path";
import { WIZARD_DATA_DIR } from "@/lib/wizard/data-dir";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const zonesPath = path.join(WIZARD_DATA_DIR, "zones.json");
    if (!fss.existsSync(zonesPath)) return NextResponse.json({ type: "FeatureCollection", features: [] });
    const zones = JSON.parse(await fs.readFile(zonesPath, "utf-8"));
    const features = Object.values(zones).filter((z: any) => z.geofence).map((z: any) => ({
      type: "Feature",
      properties: { id: z.id, name: z.name, network_id: z.network_id, priority: z.priority, color: z.color, enabled: z.enabled },
      geometry: z.geofence.type === "circle" ? { type: "Point", coordinates: [z.geofence.lon, z.geofence.lat] } :
        { type: "Polygon", coordinates: [z.geofence.points.map((p: number[]) => [p[1], p[0]])] },
    }));
    return NextResponse.json({ type: "FeatureCollection", features });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
