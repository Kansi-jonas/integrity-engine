// ─── RINEX 3.04 Observation Parser ───────────────────────────────────────────
// Parses RINEX 3.04 observation files from GEODNET PPK API.
// Extracts: pseudorange, carrier phase, SNR per satellite per epoch.
//
// RINEX format: ASCII, well-documented (IGS specification).
// Used for: cycle slip detection, multipath analysis, station QC.

export interface RinexHeader {
  version: string;
  type: string;          // "O" for observation
  marker_name: string;
  marker_number: string;
  receiver_type: string;
  receiver_firmware: string;
  receiver_serial: string;
  antenna_type: string;
  antenna_serial: string;
  approx_position: { x: number; y: number; z: number };
  antenna_delta: { h: number; e: number; n: number };
  observation_types: Record<string, string[]>;  // constellation → obs codes
  interval: number;      // seconds
  first_obs: Date;
  constellations: string[];
}

export interface RinexEpoch {
  time: Date;
  satellites: SatelliteObs[];
}

export interface SatelliteObs {
  prn: string;           // "G01", "E05", "R12", "C06"
  constellation: string; // "G", "E", "R", "C"
  observations: Record<string, number>;  // obs_code → value (e.g., "C1C" → pseudorange_m)
}

export interface RinexFile {
  header: RinexHeader;
  epochs: RinexEpoch[];
}

/**
 * Parse RINEX 3.04 observation file content.
 */
export function parseRinex(content: string): RinexFile {
  const lines = content.split("\n");
  const header = parseHeader(lines);
  const epochs = parseEpochs(lines, header);

  return { header, epochs };
}

function parseHeader(lines: string[]): RinexHeader {
  const header: RinexHeader = {
    version: "", type: "", marker_name: "", marker_number: "",
    receiver_type: "", receiver_firmware: "", receiver_serial: "",
    antenna_type: "", antenna_serial: "",
    approx_position: { x: 0, y: 0, z: 0 },
    antenna_delta: { h: 0, e: 0, n: 0 },
    observation_types: {},
    interval: 1,
    first_obs: new Date(),
    constellations: [],
  };

  for (const line of lines) {
    const label = line.substring(60).trim();

    if (label === "RINEX VERSION / TYPE") {
      header.version = line.substring(0, 9).trim();
      header.type = line.substring(20, 21).trim();
    } else if (label === "MARKER NAME") {
      header.marker_name = line.substring(0, 60).trim();
    } else if (label === "MARKER NUMBER") {
      header.marker_number = line.substring(0, 20).trim();
    } else if (label === "REC # / TYPE / VERS") {
      header.receiver_serial = line.substring(0, 20).trim();
      header.receiver_type = line.substring(20, 40).trim();
      header.receiver_firmware = line.substring(40, 60).trim();
    } else if (label === "ANT # / TYPE") {
      header.antenna_serial = line.substring(0, 20).trim();
      header.antenna_type = line.substring(20, 40).trim();
    } else if (label === "APPROX POSITION XYZ") {
      const parts = line.substring(0, 60).trim().split(/\s+/);
      header.approx_position = {
        x: parseFloat(parts[0]) || 0,
        y: parseFloat(parts[1]) || 0,
        z: parseFloat(parts[2]) || 0,
      };
    } else if (label === "ANTENNA: DELTA H/E/N") {
      const parts = line.substring(0, 60).trim().split(/\s+/);
      header.antenna_delta = {
        h: parseFloat(parts[0]) || 0,
        e: parseFloat(parts[1]) || 0,
        n: parseFloat(parts[2]) || 0,
      };
    } else if (label.startsWith("SYS / # / OBS TYPES")) {
      const sys = line.charAt(0);
      if (sys !== " ") {
        const numTypes = parseInt(line.substring(3, 6).trim()) || 0;
        const types = line.substring(7, 60).trim().split(/\s+/).filter(t => t.length > 0);
        header.observation_types[sys] = types;
        if (!header.constellations.includes(sys)) header.constellations.push(sys);
      }
    } else if (label === "INTERVAL") {
      header.interval = parseFloat(line.substring(0, 10).trim()) || 1;
    } else if (label === "TIME OF FIRST OBS") {
      const parts = line.substring(0, 43).trim().split(/\s+/);
      if (parts.length >= 6) {
        header.first_obs = new Date(Date.UTC(
          parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
          parseInt(parts[3]), parseInt(parts[4]), parseFloat(parts[5]) || 0
        ));
      }
    } else if (label === "END OF HEADER") {
      break;
    }
  }

  return header;
}

function parseEpochs(lines: string[], header: RinexHeader): RinexEpoch[] {
  const epochs: RinexEpoch[] = [];
  let inHeader = true;
  let i = 0;

  // Skip header
  for (; i < lines.length; i++) {
    if (lines[i].substring(60).trim() === "END OF HEADER") { i++; break; }
  }

  // Parse epochs (limit to 3600 for memory — 1 hour at 1Hz)
  const maxEpochs = 3600;

  for (; i < lines.length && epochs.length < maxEpochs; i++) {
    const line = lines[i];
    if (!line || line.length < 35) continue;

    // Epoch header: > YYYY MM DD HH MM SS.SSSSSSS  FLAG  NUM_SAT
    if (line.charAt(0) === ">") {
      const parts = line.substring(2, 35).trim().split(/\s+/);
      if (parts.length < 6) continue;

      const time = new Date(Date.UTC(
        parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
        parseInt(parts[3]), parseInt(parts[4]), parseFloat(parts[5]) || 0
      ));

      const flag = parseInt(parts[6] || "0");
      const numSat = parseInt(parts[7] || line.substring(32, 35).trim()) || 0;

      if (flag > 1) { // Skip special records (power failure, etc.)
        i += numSat;
        continue;
      }

      const satellites: SatelliteObs[] = [];

      for (let s = 0; s < numSat && i + 1 < lines.length; s++) {
        i++;
        const satLine = lines[i];
        if (!satLine || satLine.length < 3) continue;

        const sys = satLine.charAt(0);
        const prn = satLine.substring(0, 3).trim();
        const obsTypes = header.observation_types[sys] || [];
        const observations: Record<string, number> = {};

        for (let t = 0; t < obsTypes.length; t++) {
          const start = 3 + t * 16;
          const valStr = satLine.substring(start, start + 14).trim();
          if (valStr) {
            const val = parseFloat(valStr);
            if (!isNaN(val) && val !== 0) {
              observations[obsTypes[t]] = val;
            }
          }
        }

        if (Object.keys(observations).length > 0) {
          satellites.push({
            prn,
            constellation: sys,
            observations,
          });
        }
      }

      if (satellites.length > 0) {
        epochs.push({ time, satellites });
      }
    }
  }

  return epochs;
}

/**
 * Get summary statistics from a parsed RINEX file.
 */
export function getRinexSummary(rinex: RinexFile): {
  duration_seconds: number;
  total_epochs: number;
  constellations: string[];
  satellite_count: number;
  frequencies: string[];
  receiver: string;
  antenna: string;
  mean_satellites_per_epoch: number;
} {
  const allPrns = new Set<string>();
  const allFreqs = new Set<string>();
  let totalSats = 0;

  for (const epoch of rinex.epochs) {
    totalSats += epoch.satellites.length;
    for (const sat of epoch.satellites) {
      allPrns.add(sat.prn);
      for (const obs of Object.keys(sat.observations)) {
        allFreqs.add(obs.substring(0, 2)); // "C1", "L1", "S1", etc.
      }
    }
  }

  const firstTime = rinex.epochs[0]?.time.getTime() || 0;
  const lastTime = rinex.epochs[rinex.epochs.length - 1]?.time.getTime() || 0;

  return {
    duration_seconds: (lastTime - firstTime) / 1000,
    total_epochs: rinex.epochs.length,
    constellations: rinex.header.constellations,
    satellite_count: allPrns.size,
    frequencies: [...allFreqs].sort(),
    receiver: rinex.header.receiver_type,
    antenna: rinex.header.antenna_type,
    mean_satellites_per_epoch: rinex.epochs.length > 0 ? Math.round(totalSats / rinex.epochs.length * 10) / 10 : 0,
  };
}
