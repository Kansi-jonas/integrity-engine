// ─── Config Preview API ──────────────────────────────────────────────────────
// GET /api/config/preview — returns the generated ntrips.cfg with metadata
// GET /api/config/preview?format=raw — returns raw config text (downloadable)

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const format = req.nextUrl.searchParams.get("format") || "json";
  const dataDir = getDataDir();

  try {
    // Try to load generated config
    const configPath = path.join(dataDir, "ntrips.cfg");
    let config = "";
    let exists = false;

    if (fs.existsSync(configPath)) {
      config = fs.readFileSync(configPath, "utf-8");
      exists = true;
    }

    // If no config file, try to generate one
    if (!exists) {
      try {
        const wizardDir = path.join(dataDir, "wizard");
        if (fs.existsSync(path.join(wizardDir, "networks.json"))) {
          const { generateConfig } = require("@/lib/wizard/config-engine");

          // Load all wizard data
          const loadJson = (name: string) => {
            try { return JSON.parse(fs.readFileSync(path.join(wizardDir, `${name}.json`), "utf-8")); }
            catch { return {}; }
          };

          const input = {
            networks: loadJson("networks"),
            networkMountpoints: loadJson("network_mountpoints"),
            mountpoints: loadJson("mountpoints"),
            users: loadJson("users"),
            groups: loadJson("groups"),
            zones: loadJson("zones"),
            streams: loadJson("streams"),
            accounts: loadJson("accounts"),
            aliases: loadJson("aliases"),
            settings: loadJson("settings"),
          };

          config = generateConfig(input);
          exists = true;
        }
      } catch (err) {
        config = `# Config generation failed: ${err}`;
      }
    }

    // Mask credentials in preview (never expose API keys in browser)
    // CRITICAL: [^\n] prevents matching across newlines (was eating entire pinput lines)
    const maskedConfig = config.replace(
      /\/([^:\n]+):([^@\n]+)@/g,
      (_, user, pass) => `/${user}:${"*".repeat(Math.min(8, pass.length))}@`
    );

    if (format === "raw") {
      return new Response(maskedConfig || "# No config generated yet", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="ntrips.cfg"',
        },
      });
    }

    // Count config elements
    const lines = config.split("\n");
    const pinputs = lines.filter(l => l.trim().startsWith("--pinput")).length;
    const smarkers = lines.filter(l => l.trim().startsWith("--smarker")).length;
    const users = lines.filter(l => l.trim().startsWith("--user")).length;
    const groups = lines.filter(l => l.trim().startsWith("--group")).length;
    const zones = lines.filter(l => l.includes("circle(") || l.includes("polygon(")).length;

    // Load safety check
    let safety = null;
    try {
      const { validateConfigSafety } = require("@/lib/config-safety");
      safety = validateConfigSafety(config, dataDir);
    } catch {}

    // Load zone build stats
    let zoneBuild = null;
    try {
      const zbPath = path.join(dataDir, "zone-build.json");
      if (fs.existsSync(zbPath)) {
        const zb = JSON.parse(fs.readFileSync(zbPath, "utf-8"));
        zoneBuild = zb.stats;
      }
    } catch {}

    return NextResponse.json({
      config: exists ? maskedConfig : null,
      exists,
      stats: {
        total_lines: lines.length,
        pinputs,
        smarkers,
        users,
        groups,
        zones,
        size_kb: Math.round(config.length / 1024 * 10) / 10,
      },
      safety,
      zone_build: zoneBuild,
      generated_at: exists && fs.existsSync(configPath)
        ? new Date(fs.statSync(configPath).mtimeMs).toISOString()
        : null,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
