// ─── Wizard Data CRUD API ────────────────────────────────────────────────────
// Ported from GNSS Wizard: generic CRUD for zones, networks, mountpoints, etc.
// Data stored in /data/wizard/*.json on persistent disk.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import fss from "fs";
import path from "path";
import { WIZARD_DATA_DIR } from "@/lib/wizard/data-dir";

const ALLOWED = new Set(["networks", "network_mountpoints", "mountpoints", "users", "groups", "zones", "streams", "accounts", "aliases", "settings"]);

let writeLock = Promise.resolve();

async function writeJsonSafe(filePath: string, data: unknown) {
  writeLock = writeLock.then(async () => {
    const tmp = filePath + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmp, filePath);
  });
  return writeLock;
}

function ensureDir() {
  if (!fss.existsSync(WIZARD_DATA_DIR)) fss.mkdirSync(WIZARD_DATA_DIR, { recursive: true });
}

function getPath(entity: string): string {
  if (!ALLOWED.has(entity)) throw new Error(`Unknown entity: ${entity}`);
  return path.join(WIZARD_DATA_DIR, `${entity}.json`);
}

async function readEntity(entity: string): Promise<Record<string, unknown>> {
  ensureDir();
  const p = getPath(entity);
  try {
    return JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    return {};
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!ALLOWED.has(entity)) return NextResponse.json({ error: "Unknown entity" }, { status: 404 });
  try {
    const data = await readEntity(entity);
    if (entity === "zones") {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data)) {
        if (!k.startsWith("meridian_")) filtered[k] = v;
      }
      return NextResponse.json(filtered);
    }
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!ALLOWED.has(entity)) return NextResponse.json({ error: "Unknown entity" }, { status: 404 });
  try {
    ensureDir();
    const data = await request.json();
    await writeJsonSafe(getPath(entity), data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!ALLOWED.has(entity)) return NextResponse.json({ error: "Unknown entity" }, { status: 404 });
  try {
    ensureDir();
    const { key, value } = await request.json();
    if (typeof key !== "string" || !key) return NextResponse.json({ error: "Missing key" }, { status: 400 });
    const existing = await readEntity(entity);
    await writeJsonSafe(getPath(entity), { ...existing, [key]: value });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params;
  if (!ALLOWED.has(entity)) return NextResponse.json({ error: "Unknown entity" }, { status: 404 });
  try {
    const key = request.nextUrl.searchParams.get("key");
    if (!key) return NextResponse.json({ error: "Missing key" }, { status: 400 });
    const existing = await readEntity(entity);
    const { [key]: _del, ...rest } = existing;
    await writeJsonSafe(getPath(entity), rest);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
