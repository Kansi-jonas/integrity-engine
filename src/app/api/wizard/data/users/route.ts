import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import fss from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(process.cwd(), 'data'), 'wizard');

export const dynamic = 'force-dynamic';

function ensureDir() { if (!fss.existsSync(DATA_DIR)) fss.mkdirSync(DATA_DIR, { recursive: true }); }
function getPath(): string { return path.join(DATA_DIR, 'users.json'); }

async function readData(): Promise<Record<string, unknown>> {
  ensureDir();
  try { return JSON.parse(await fs.readFile(getPath(), 'utf-8')); } catch { return {}; }
}

export async function GET() {
  try { return NextResponse.json(await readData()); }
  catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}

export async function PUT(request: NextRequest) {
  try {
    ensureDir();
    const data = await request.json();
    const tmp = getPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, getPath());
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}

export async function PATCH(request: NextRequest) {
  try {
    ensureDir();
    const { key, value } = await request.json();
    if (typeof key !== 'string' || !key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });
    const existing = await readData();
    const tmp = getPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ ...existing, [key]: value }, null, 2), 'utf-8');
    await fs.rename(tmp, getPath());
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}

export async function DELETE(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get('key');
    if (!key) return NextResponse.json({ error: 'Missing key' }, { status: 400 });
    const existing = await readData();
    const { [key]: _del, ...rest } = existing;
    const tmp = getPath() + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(rest, null, 2), 'utf-8');
    await fs.rename(tmp, getPath());
    return NextResponse.json({ ok: true });
  } catch (e) { return NextResponse.json({ error: String(e) }, { status: 500 }); }
}
