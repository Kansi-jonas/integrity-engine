// ─── Wizard Auto-Setup ───────────────────────────────────────────────────────
// Creates the base Wizard configuration (Networks, Mountpoints, Groups)
// if they don't exist yet. This ensures the Config Engine can generate
// a valid ntrips.cfg even on a fresh install.
//
// Networks:
//   - GEODNET (rtk.geodnet.com:2101)
//   - ONOCOY (clients.onocoy.com:2101)
//   - IGS PPP (products.igs-ip.net:2101) — fallback only
//
// Mountpoints:
//   - SMART (primary: GEODNET AUTO + ONOCOY NRBY_ADV failover)
//   - SMART_WGS84 (same but WGS84 output)
//
// This runs once at startup if wizard/networks.json is empty.

import fs from "fs";
import path from "path";

export function ensureWizardSetup(dataDir: string) {
  const wizardDir = path.join(dataDir, "wizard");
  if (!fs.existsSync(wizardDir)) fs.mkdirSync(wizardDir, { recursive: true });

  // Check if already set up
  const networksPath = path.join(wizardDir, "networks.json");
  try {
    const existing = JSON.parse(fs.readFileSync(networksPath, "utf-8"));
    if (Object.keys(existing).length > 0) return; // Already configured
  } catch {}

  console.log("[WIZARD-SETUP] First run — creating default configuration...");

  // ── Networks ────────────────────────────────────────────────────────────
  const networks: Record<string, any> = {
    geodnet: {
      id: "geodnet",
      name: "GEODNET",
      host: "rtk.geodnet.com",
      port: 2101,
      protocol: "ntrip",
    },
    onocoy: {
      id: "onocoy",
      name: "ONOCOY",
      host: "clients.onocoy.com",
      port: 2101,
      protocol: "ntrip",
    },
  };

  // ── Network Mountpoints ─────────────────────────────────────────────────
  const networkMountpoints: Record<string, any> = {
    geodnet_auto: {
      id: "geodnet_auto",
      network_id: "geodnet",
      mountpoint: "AUTO",
      pass_nmea: true,
      marker_name: "GEOD_AUTO",
    },
    geodnet_nrby: {
      id: "geodnet_nrby",
      network_id: "geodnet",
      mountpoint: "NRBY_ADV",
      pass_nmea: true,
      marker_name: "GEOD_NRBY",
    },
    onocoy_nrby: {
      id: "onocoy_nrby",
      network_id: "onocoy",
      mountpoint: "NRBY_ADV",
      pass_nmea: true,
      marker_name: "ONO_NRBY",
    },
  };

  // ── Mountpoints (customer-facing) ───────────────────────────────────────
  const mountpoints: Record<string, any> = {
    smart: {
      id: "smart",
      name: "SMART",
      backends: [
        { network_mountpoint_id: "geodnet_auto", priority: 1 },
        { network_mountpoint_id: "geodnet_nrby", priority: 5 },
        { network_mountpoint_id: "onocoy_nrby", priority: 20 },
      ],
      enabled: true,
      overlap: 5000,
    },
  };

  // ── Groups ──────────────────────────────────────────────────────────────
  const groups: Record<string, any> = {
    default: {
      name: "default",
      users: [],
      geofences: [],
      credentials: [
        {
          network_id: "geodnet",
          username: process.env.GEODNET_APP_ID || "kansi",
          password: process.env.GEODNET_APP_KEY || "",
        },
        {
          network_id: "onocoy",
          username: process.env.ONOCOY_USER || "",
          password: process.env.ONOCOY_PASS || "",
        },
      ],
    },
  };

  // ── Settings ────────────────────────────────────────────────────────────
  const settings: any = {
    logfile: "/var/log/ntrips/ntrips.log",
    loglevel: "1",
    runtimecheck: "60",
    ports: "2101",
    tcptimeout: "60",
    nmealosstimeout: "120",
    connectionlimit: "5000",
    kickonlimit: true,
    maxclients: "5000",
    inputtimeout: "30",
    casterHost: "rtk.rtkdata.com",
    casterIdentifier: "RTKdata NTRIP Caster",
    casterOperator: "Kansi Solutions GmbH",
    casterCountry: "DEU",
    casterLat: "49.35",
    casterLon: "7.15",
    casterUrl: "https://rtkdata.com",
  };

  // ── Write all files ─────────────────────────────────────────────────────
  const files: Record<string, any> = {
    "networks.json": networks,
    "network_mountpoints.json": networkMountpoints,
    "mountpoints.json": mountpoints,
    "groups.json": groups,
    "users.json": {},
    "zones.json": {},
    "streams.json": {},
    "accounts.json": {},
    "aliases.json": {},
    "settings.json": settings,
    "quality_scans.json": {},
  };

  for (const [filename, data] of Object.entries(files)) {
    const filePath = path.join(wizardDir, filename);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
  }

  console.log("[WIZARD-SETUP] Default configuration created: 2 networks, 3 network mountpoints, 1 mountpoint (SMART), 1 group");
}
