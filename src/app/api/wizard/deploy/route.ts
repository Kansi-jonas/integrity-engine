// ─── Wizard Deploy API ───────────────────────────────────────────────────────
// POST /api/wizard/deploy — generates config + uploads to Alberding via SSH
// Uses persistent SSH credentials from env vars (unlike original Wizard
// which uses session-based credentials).

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import fss from "fs";
import path from "path";
import { Client } from "ssh2";
import { WIZARD_DATA_DIR } from "@/lib/wizard/data-dir";

export const dynamic = "force-dynamic";

const DEPLOY_HOST = process.env.CASTER_HOST || "";
const DEPLOY_PORT = parseInt(process.env.CASTER_PORT || "22");
const DEPLOY_USER = process.env.CASTER_USER || "root";
const DEPLOY_KEY = process.env.CASTER_KEY || "";       // Private key content
const DEPLOY_PASS = process.env.CASTER_PASS || "";     // Password fallback
const CASTER_CONFIG_PATH = "/etc/euronav/ntrips.cfg";

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "upload"; // upload, verify, test

    if (!DEPLOY_HOST) {
      return NextResponse.json({ error: "CASTER_HOST not configured" }, { status: 400 });
    }

    if (action === "test") {
      // Just test SSH connection
      const result = await testConnection();
      return NextResponse.json(result);
    }

    if (action === "verify") {
      // Run ntrips --verify on remote
      const output = await runRemoteCommand(`ntrips --verify -c ${CASTER_CONFIG_PATH} 2>&1`);
      return NextResponse.json({ output, success: !output.includes("ERROR") });
    }

    // Default: generate + upload
    // Step 1: Generate config
    const configRes = await fetch(new URL("/api/wizard/config", request.url).toString(), {
      headers: request.headers,
    });
    const configData = await configRes.json();
    if (!configData.config) {
      return NextResponse.json({ error: "Config generation failed", details: configData }, { status: 500 });
    }

    // Step 2: Upload via SCP
    const uploaded = await uploadConfig(configData.config);
    if (!uploaded.success) {
      return NextResponse.json({ error: "Upload failed", details: uploaded.error }, { status: 500 });
    }

    // Step 3: Verify
    let verification = "";
    try {
      verification = await runRemoteCommand(`ntrips --verify -c ${CASTER_CONFIG_PATH} 2>&1`);
    } catch {}

    return NextResponse.json({
      success: true,
      config_lines: configData.config.split("\n").length,
      uploaded_at: new Date().toISOString(),
      verification: verification || "Verification skipped",
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function getAuthConfig(): any {
  const auth: any = {
    host: DEPLOY_HOST,
    port: DEPLOY_PORT,
    username: DEPLOY_USER,
    readyTimeout: 15000,
  };

  if (DEPLOY_KEY) {
    auth.privateKey = DEPLOY_KEY;
  } else if (DEPLOY_PASS) {
    auth.password = DEPLOY_PASS;
  }

  return auth;
}

async function testConnection(): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      resolve({ success: false, error: "Connection timeout" });
    }, 10000);

    conn.on("ready", () => {
      clearTimeout(timeout);
      conn.end();
      resolve({ success: true });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });

    conn.connect(getAuthConfig());
  });
}

async function uploadConfig(configContent: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      resolve({ success: false, error: "Upload timeout" });
    }, 30000);

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          resolve({ success: false, error: err.message });
          return;
        }

        // Backup existing config
        conn.exec(`cp ${CASTER_CONFIG_PATH} ${CASTER_CONFIG_PATH}~`, () => {
          // Write new config
          const writeStream = sftp.createWriteStream(CASTER_CONFIG_PATH);
          writeStream.on("close", () => {
            clearTimeout(timeout);
            conn.end();
            resolve({ success: true });
          });
          writeStream.on("error", (writeErr: Error) => {
            clearTimeout(timeout);
            conn.end();
            resolve({ success: false, error: writeErr.message });
          });
          writeStream.write(configContent);
          writeStream.end();
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });

    conn.connect(getAuthConfig());
  });
}

async function runRemoteCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error("Command timeout"));
    }, 15000);

    conn.on("ready", () => {
      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); reject(err); return; }
        let output = "";
        stream.on("data", (data: Buffer) => { output += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { output += data.toString(); });
        stream.on("close", () => {
          clearTimeout(timeout);
          conn.end();
          resolve(output);
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect(getAuthConfig());
  });
}
