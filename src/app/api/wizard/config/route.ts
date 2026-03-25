// ─── Wizard Config Generation API ────────────────────────────────────────────
// GET /api/wizard/config — generates ntrips.cfg from wizard data files
// POST /api/wizard/config — same but also writes to /data/wizard/ntrips.cfg

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import fss from "fs";
import path from "path";
import { WIZARD_DATA_DIR } from "@/lib/wizard/data-dir";

export const dynamic = "force-dynamic";

async function readJSON(name: string) {
  try {
    const p = path.join(WIZARD_DATA_DIR, `${name}.json`);
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return {};
  }
}

export async function GET(request: NextRequest) {
  try {
    if (!fss.existsSync(WIZARD_DATA_DIR)) {
      return NextResponse.json({ config: "# No wizard data configured yet\n", warning: "Wizard data directory empty" });
    }

    const { generateConfig } = require("@/lib/wizard/config-engine");
    const {
      networkFromJSON, networkMountpointFromJSON, mountpointFromJSON,
      userFromJSON, groupFromJSON, zoneFromJSON, streamFromJSON,
      settingsFromJSON, accountFromJSON, aliasFromJSON,
    } = require("@/lib/wizard/utils");

    const [rawNetworks, rawNM, rawMountpoints, rawUsers, rawGroups, rawZones, rawStreams, rawSettings, rawAccounts, rawAliases] =
      await Promise.all([
        readJSON("networks"), readJSON("network_mountpoints"), readJSON("mountpoints"),
        readJSON("users"), readJSON("groups"), readJSON("zones"),
        readJSON("streams"), readJSON("settings"), readJSON("accounts"), readJSON("aliases"),
      ]);

    const networks = Object.fromEntries(Object.entries(rawNetworks).map(([k, v]) => [k, networkFromJSON(v)]));
    const networkMountpoints = Object.fromEntries(Object.entries(rawNM).map(([k, v]) => [k, networkMountpointFromJSON(v)]));
    const mountpoints = Object.fromEntries(Object.entries(rawMountpoints).map(([k, v]) => [k, mountpointFromJSON(v)]));
    const users = Object.fromEntries(Object.entries(rawUsers).map(([k, v]) => [k, userFromJSON(v)]));
    const groups = Object.fromEntries(Object.entries(rawGroups).map(([k, v]) => [k, groupFromJSON(v)]));
    const zones = Object.fromEntries(Object.entries(rawZones).map(([k, v]) => [k, zoneFromJSON(v)]));
    const streams = Object.fromEntries(Object.entries(rawStreams).map(([k, v]) => [k, streamFromJSON(v)]));
    const accounts = Object.fromEntries(Object.entries(rawAccounts).map(([k, v]) => [k, accountFromJSON(v)]));
    const aliases = Object.fromEntries(Object.entries(rawAliases).map(([k, v]) => [k, aliasFromJSON(v)]));
    const settings = settingsFromJSON(rawSettings);

    const input = { networks, networkMountpoints, mountpoints, users, groups, zones, streams, accounts, aliases, settings };
    const config = generateConfig(input);

    return NextResponse.json({ config, lines: config.split("\n").length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST() {
  try {
    // Generate + save to file
    const res = await GET(new NextRequest("http://localhost/api/wizard/config"));
    const data = await res.json();

    if (data.config) {
      const cfgPath = path.join(WIZARD_DATA_DIR, "ntrips.cfg");
      await fs.writeFile(cfgPath, data.config, "utf-8");
      return NextResponse.json({ ...data, saved: true, path: cfgPath });
    }

    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
