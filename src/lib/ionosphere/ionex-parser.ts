// ─── IONEX Parser ────────────────────────────────────────────────────────────
// Parses IGS Global Ionosphere Maps (GIM) in IONEX format.
// IONEX files contain VTEC (Vertical Total Electron Content) on a 2.5°×5° grid.
// Source: CODE (Center for Orbit Determination in Europe) via NASA CDDIS or AIUB.
//
// Format: ASCII, well-documented (IGS spec).
// Grid: latitude -87.5 to 87.5 (2.5° steps = 71 rows)
//        longitude -180 to 180 (5° steps = 73 columns)
// Unit: 0.1 TECU (multiply by epoch-specific exponent)

export interface IonexMap {
  epoch: Date;
  grid: number[][]; // [lat_index][lon_index] = VTEC in TECU
  lat_start: number;
  lat_end: number;
  lat_step: number;
  lon_start: number;
  lon_end: number;
  lon_step: number;
  exponent: number;
}

export interface IonexFile {
  maps: IonexMap[];
  description: string;
  epoch_interval: number; // seconds between maps
}

export function parseIonex(content: string): IonexFile {
  const lines = content.split("\n");
  const maps: IonexMap[] = [];
  let description = "";
  let exponent = -1; // default: values in 0.1 TECU
  let epochInterval = 7200; // default 2 hours

  // Header parsing
  let headerDone = false;
  let lineIdx = 0;

  // Grid specs (defaults for standard GIM)
  let latStart = 87.5, latEnd = -87.5, latStep = -2.5;
  let lonStart = -180, lonEnd = 180, lonStep = 5;

  for (; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line) continue;

    const label = line.substring(60).trim();

    if (label === "DESCRIPTION") {
      description += line.substring(0, 60).trim() + " ";
    } else if (label === "EXPONENT") {
      exponent = parseInt(line.substring(0, 6).trim()) || -1;
    } else if (label === "INTERVAL") {
      epochInterval = parseInt(line.substring(0, 6).trim()) || 7200;
    } else if (label === "HGT1 / HGT2 / DHGT") {
      // Height grid — we only care about first height (usually 450km for VTEC)
    } else if (label === "LAT1 / LAT2 / DLAT") {
      const parts = line.substring(2, 60).trim().split(/\s+/);
      if (parts.length >= 3) {
        latStart = parseFloat(parts[0]);
        latEnd = parseFloat(parts[1]);
        latStep = parseFloat(parts[2]);
      }
    } else if (label === "LON1 / LON2 / DLON") {
      const parts = line.substring(2, 60).trim().split(/\s+/);
      if (parts.length >= 3) {
        lonStart = parseFloat(parts[0]);
        lonEnd = parseFloat(parts[1]);
        lonStep = parseFloat(parts[2]);
      }
    } else if (label === "END OF HEADER") {
      headerDone = true;
      lineIdx++;
      break;
    }
  }

  if (!headerDone) return { maps: [], description, epoch_interval: epochInterval };

  const scaleFactor = Math.pow(10, exponent);
  const nLat = Math.round((latEnd - latStart) / latStep) + 1;
  const nLon = Math.round((lonEnd - lonStart) / lonStep) + 1;

  // Parse TEC maps
  let currentMap: IonexMap | null = null;
  let currentLatIdx = 0;
  let lonValues: number[] = [];

  for (; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (!line) continue;

    const label = line.substring(60).trim();

    if (label === "START OF TEC MAP") {
      currentMap = {
        epoch: new Date(),
        grid: [],
        lat_start: latStart,
        lat_end: latEnd,
        lat_step: latStep,
        lon_start: lonStart,
        lon_end: lonEnd,
        lon_step: lonStep,
        exponent,
      };
      currentLatIdx = 0;
      continue;
    }

    if (label === "END OF TEC MAP" && currentMap) {
      maps.push(currentMap);
      currentMap = null;
      continue;
    }

    if (label === "EPOCH OF CURRENT MAP" && currentMap) {
      // Parse: YYYY MM DD HH MM SS
      const parts = line.substring(0, 60).trim().split(/\s+/);
      if (parts.length >= 6) {
        currentMap.epoch = new Date(Date.UTC(
          parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
          parseInt(parts[3]), parseInt(parts[4]), parseInt(parts[5]) || 0
        ));
      }
      continue;
    }

    if (currentMap && line.substring(60).trim().startsWith("LAT/LON1/LON2/DLON/H")) {
      // New latitude row — flush previous
      if (lonValues.length > 0 && currentLatIdx > 0) {
        currentMap.grid.push(lonValues.map(v => v * scaleFactor));
      }
      lonValues = [];
      currentLatIdx++;
      continue;
    }

    // Data lines: 16 values per line, 5 chars each
    if (currentMap && !line.substring(60).trim()) {
      const vals = line.substring(0, 80).match(/.{1,5}/g);
      if (vals) {
        for (const v of vals) {
          const num = parseInt(v.trim());
          if (!isNaN(num)) lonValues.push(num);
        }
      }
    }
  }

  // Flush last latitude row
  if (currentMap && lonValues.length > 0) {
    currentMap.grid.push(lonValues.map(v => v * scaleFactor));
  }

  return { maps, description: description.trim(), epoch_interval: epochInterval };
}
