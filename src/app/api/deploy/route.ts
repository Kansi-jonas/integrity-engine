// ─── Deploy API ──────────────────────────────────────────────────────────────
// POST /api/deploy — deploy current config to all caster instances
// GET /api/deploy — check deploy status and caster info

import { NextRequest, NextResponse } from "next/server";
import { getDb, getDataDir } from "@/lib/db";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

export async function GET() {
  const dataDir = getDataDir();

  // Load last deploy result
  let lastDeploy = null;
  try {
    const deployPath = path.join(dataDir, "last-deploy.json");
    if (fs.existsSync(deployPath)) {
      lastDeploy = JSON.parse(fs.readFileSync(deployPath, "utf-8"));
    }
  } catch {}

  // Check if config exists
  const configPath = path.join(dataDir, "ntrips.cfg");
  const configExists = fs.existsSync(configPath);
  const configSize = configExists ? fs.statSync(configPath).size : 0;
  const configModified = configExists ? new Date(fs.statSync(configPath).mtimeMs).toISOString() : null;

  // Caster instances configured
  const casters = [];
  if (process.env.CASTER_EU_HOST) casters.push({ id: "eu", name: "EU Central", host: process.env.CASTER_EU_HOST, region: "Frankfurt" });
  if (process.env.CASTER_US_HOST) casters.push({ id: "us", name: "US East", host: process.env.CASTER_US_HOST, region: "Virginia" });
  if (process.env.CASTER_AP_HOST) casters.push({ id: "ap", name: "APAC", host: process.env.CASTER_AP_HOST, region: "Sydney" });

  // Rollback available
  let rollbackCount = 0;
  try {
    const rollbackDir = path.join(dataDir, "config-rollback");
    if (fs.existsSync(rollbackDir)) {
      rollbackCount = fs.readdirSync(rollbackDir).filter(f => f.endsWith(".cfg")).length;
    }
  } catch {}

  return NextResponse.json({
    config_exists: configExists,
    config_size_kb: Math.round(configSize / 1024 * 10) / 10,
    config_modified: configModified,
    casters,
    casters_configured: casters.length,
    rollback_available: rollbackCount,
    last_deploy: lastDeploy,
    auto_deploy_enabled: process.env.FENCE_AUTO_DEPLOY === "true",
  });
}

export async function POST(req: NextRequest) {
  const dataDir = getDataDir();
  const action = req.nextUrl.searchParams.get("action") || "deploy";

  if (action === "rollback") {
    // Restore last rollback
    try {
      const { getLatestRollback } = require("@/lib/config-safety");
      const rollbackConfig = getLatestRollback(dataDir);
      if (!rollbackConfig) {
        return NextResponse.json({ error: "No rollback available" }, { status: 404 });
      }

      const { deployConfig } = require("@/lib/caster-deploy");
      const result = await deployConfig(rollbackConfig, dataDir);

      // Persist deploy result
      try {
        fs.writeFileSync(
          path.join(dataDir, "last-deploy.json"),
          JSON.stringify({ ...result, action: "rollback" }, null, 2)
        );
      } catch {}

      return NextResponse.json({ ...result, action: "rollback" });
    } catch (error) {
      return NextResponse.json({ error: String(error) }, { status: 500 });
    }
  }

  // Normal deploy
  try {
    const configPath = path.join(dataDir, "ntrips.cfg");
    if (!fs.existsSync(configPath)) {
      return NextResponse.json({ error: "No config file to deploy. Run the quality pipeline first." }, { status: 404 });
    }

    const config = fs.readFileSync(configPath, "utf-8");
    const { deployConfig } = require("@/lib/caster-deploy");
    const result = await deployConfig(config, dataDir);

    // Persist deploy result
    try {
      fs.writeFileSync(
        path.join(dataDir, "last-deploy.json"),
        JSON.stringify({ ...result, action: "deploy" }, null, 2)
      );
    } catch {}

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
