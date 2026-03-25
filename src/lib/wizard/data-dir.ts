import path from "path";
import { getDataDir } from "@/lib/db";

// Wizard data lives in the same persistent disk as integrity data
export const WIZARD_DATA_DIR = path.join(getDataDir(), "wizard");
