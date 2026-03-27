// ─── RTCM 1033 Probe ─────────────────────────────────────────────────────────
// Connects to ONOCOY NTRIP stream for 10-15 seconds and extracts:
// - RTCM Message 1033: Receiver Descriptor (exact hardware name)
// - RTCM Message Types received (MSM4/5/7)
// - Data rate (bytes/s)
// - Latency (time to first message)
//
// This gives us the EXACT receiver brand: "LEICA GR25", "TRIMBLE NETR9", "U-BLOX ZED-F9P"
// No more guessing from sourcetable.

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProbeResult {
  station: string;
  receiver_descriptor: string | null;  // From RTCM 1033
  antenna_descriptor: string | null;   // From RTCM 1033
  receiver_serial: string | null;
  firmware_version: string | null;
  message_types: number[];             // RTCM message IDs received
  has_msm7: boolean;
  has_msm5: boolean;
  has_msm4: boolean;
  constellations: string[];            // GPS, GLO, GAL, BDS detected from messages
  data_rate_bps: number;
  latency_ms: number;
  probe_duration_s: number;
  success: boolean;
  error: string | null;
  probed_at: string;
}

// ─── RTCM Message ID → Constellation Mapping ────────────────────────────────

const MSG_CONSTELLATION: Record<number, string> = {
  1071: "GPS", 1072: "GPS", 1073: "GPS", 1074: "GPS", 1075: "GPS", 1076: "GPS", 1077: "GPS",
  1081: "GLO", 1082: "GLO", 1083: "GLO", 1084: "GLO", 1085: "GLO", 1086: "GLO", 1087: "GLO",
  1091: "GAL", 1092: "GAL", 1093: "GAL", 1094: "GAL", 1095: "GAL", 1096: "GAL", 1097: "GAL",
  1121: "BDS", 1122: "BDS", 1123: "BDS", 1124: "BDS", 1125: "BDS", 1126: "BDS", 1127: "BDS",
};

const MSM7_IDS = [1077, 1087, 1097, 1127];
const MSM5_IDS = [1075, 1085, 1095, 1125];
const MSM4_IDS = [1074, 1084, 1094, 1124];

// ─── RTCM Frame Parser ──────────────────────────────────────────────────────

function parseRtcmMessageId(data: Buffer, offset: number): number | null {
  // RTCM 3 frame: D3 00 LL (3 bytes header) + payload
  // First 12 bits of payload = message ID
  if (offset + 3 >= data.length) return null;
  if (data[offset] !== 0xD3) return null;

  const payloadStart = offset + 3;
  if (payloadStart + 2 > data.length) return null;

  const msgId = (data[payloadStart] << 4) | (data[payloadStart + 1] >> 4);
  return msgId;
}

function parseRtcm1033(data: Buffer, offset: number): {
  receiver: string; antenna: string; serial: string; firmware: string;
} | null {
  // RTCM 1033: Receiver and Antenna Descriptors
  // After message ID (12 bits):
  // - Reference station ID (12 bits)
  // - Antenna descriptor length (8 bits) + string
  // - Antenna setup ID (8 bits)
  // - Antenna serial length (8 bits) + string
  // - Receiver descriptor length (8 bits) + string
  // - Receiver firmware length (8 bits) + string
  // - Receiver serial length (8 bits) + string

  try {
    if (offset + 6 >= data.length) return null;
    if (data[offset] !== 0xD3) return null;

    const len = ((data[offset + 1] & 0x03) << 8) | data[offset + 2];
    const payloadStart = offset + 3;
    if (payloadStart + len > data.length) return null;

    // Check message ID = 1033
    const msgId = (data[payloadStart] << 4) | (data[payloadStart + 1] >> 4);
    if (msgId !== 1033) return null;

    // Parse bit by bit is complex — use a simpler approach:
    // Look for ASCII strings in the payload
    const payload = data.subarray(payloadStart, payloadStart + len);
    const strings = extractAsciiStrings(payload, 3); // min 3 chars

    // Typically: [antenna_descriptor, antenna_serial, receiver_descriptor, receiver_firmware, receiver_serial]
    const receiver = strings.find(s =>
      /LEICA|TRIMBLE|SEPT|NOVATEL|JAVAD|TOPCON|CHC|U-BLOX|UBLOX|F9P|ZED|STONEX|TERSUS/i.test(s)
    ) || strings[2] || "";

    const antenna = strings.find(s =>
      /LEIAR|TRM|SEPCH|NOV|ASH|AOAD|JPSRE/i.test(s)
    ) || strings[0] || "";

    return {
      receiver: receiver.trim(),
      antenna: antenna.trim(),
      serial: strings[4]?.trim() || "",
      firmware: strings[3]?.trim() || "",
    };
  } catch {
    return null;
  }
}

function extractAsciiStrings(buf: Buffer, minLength: number): string[] {
  const strings: string[] = [];
  let current = "";

  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c >= 0x20 && c <= 0x7E) {
      current += String.fromCharCode(c);
    } else {
      if (current.length >= minLength) {
        strings.push(current);
      }
      current = "";
    }
  }
  if (current.length >= minLength) strings.push(current);

  return strings;
}

// ─── NTRIP Probe ─────────────────────────────────────────────────────────────

export async function probeOnocoyStation(
  stationName: string,
  host = "clients.onocoy.com",
  port = 2101,
  mountpoint?: string, // If not set, connect directly to stationName as mountpoint
  durationMs = 12000
): Promise<ProbeResult> {
  // Connect directly to the station mountpoint, NOT NRBY_ADV
  // Each ONOCOY station IS a mountpoint (e.g. AIAGEOGEO1, ANDLAXLAX1)
  if (!mountpoint) mountpoint = stationName;
  const startTime = Date.now();

  const result: ProbeResult = {
    station: stationName,
    receiver_descriptor: null,
    antenna_descriptor: null,
    receiver_serial: null,
    firmware_version: null,
    message_types: [],
    has_msm7: false,
    has_msm5: false,
    has_msm4: false,
    constellations: [],
    data_rate_bps: 0,
    latency_ms: 0,
    probe_duration_s: 0,
    success: false,
    error: null,
    probed_at: new Date().toISOString(),
  };

  const onoUser = process.env.ONOCOY_USER || "";
  const onoPass = process.env.ONOCOY_PASS || "";

  if (!onoUser) {
    result.error = "ONOCOY_USER not set";
    return result;
  }

  try {
    const net = await import("net");

    return new Promise<ProbeResult>((resolve) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        result.probe_duration_s = (Date.now() - startTime) / 1000;
        result.success = result.message_types.length > 0;
        resolve(result);
      }, durationMs);

      const socket = new net.Socket();
      let totalBytes = 0;
      let firstDataTime = 0;
      const msgTypesSet = new Set<number>();
      const constellationsSet = new Set<string>();
      let buffer = Buffer.alloc(0);

      socket.connect(port, host, () => {
        // Send NTRIP request with GGA
        const auth = Buffer.from(`${onoUser}:${onoPass}`).toString("base64");
        const gga = `$GPGGA,120000.00,0000.0000,N,00000.0000,E,1,12,1.0,0.0,M,0.0,M,,*47`;
        const request = [
          `GET /${mountpoint} HTTP/1.1`,
          `Host: ${host}`,
          `Ntrip-Version: Ntrip/2.0`,
          `User-Agent: NTRIP RTKdata-Probe/1.0`,
          `Authorization: Basic ${auth}`,
          `Ntrip-GGA: ${gga}`,
          ``,
          ``,
        ].join("\r\n");
        socket.write(request);
      });

      socket.on("data", (data: Buffer) => {
        if (firstDataTime === 0) {
          firstDataTime = Date.now();
          result.latency_ms = firstDataTime - startTime;
        }
        totalBytes += data.length;

        // Accumulate buffer for RTCM parsing
        buffer = Buffer.concat([buffer, data]);

        // Parse RTCM frames
        let offset = 0;
        while (offset < buffer.length - 3) {
          if (buffer[offset] === 0xD3) {
            const len = ((buffer[offset + 1] & 0x03) << 8) | buffer[offset + 2];
            const frameLen = 3 + len + 3; // header + payload + CRC

            if (offset + frameLen > buffer.length) break; // Incomplete frame

            const msgId = parseRtcmMessageId(buffer, offset);
            if (msgId) {
              msgTypesSet.add(msgId);
              const constellation = MSG_CONSTELLATION[msgId];
              if (constellation) constellationsSet.add(constellation);

              // Try to parse 1033
              if (msgId === 1033) {
                const desc = parseRtcm1033(buffer, offset);
                if (desc) {
                  result.receiver_descriptor = desc.receiver || null;
                  result.antenna_descriptor = desc.antenna || null;
                  result.receiver_serial = desc.serial || null;
                  result.firmware_version = desc.firmware || null;
                }
              }
            }

            offset += frameLen;
          } else {
            offset++;
          }
        }
        buffer = buffer.subarray(offset);
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        result.error = err.message;
        result.probe_duration_s = (Date.now() - startTime) / 1000;
        resolve(result);
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        result.message_types = [...msgTypesSet].sort((a, b) => a - b);
        result.constellations = [...constellationsSet].sort();
        result.has_msm7 = MSM7_IDS.some(id => msgTypesSet.has(id));
        result.has_msm5 = MSM5_IDS.some(id => msgTypesSet.has(id));
        result.has_msm4 = MSM4_IDS.some(id => msgTypesSet.has(id));
        result.data_rate_bps = result.probe_duration_s > 0 ? Math.round(totalBytes / result.probe_duration_s) : 0;
        result.probe_duration_s = (Date.now() - startTime) / 1000;
        result.success = result.message_types.length > 0;
        resolve(result);
      });
    });
  } catch (err) {
    result.error = String(err);
    result.probe_duration_s = (Date.now() - startTime) / 1000;
    return result;
  }
}

/**
 * Save probe result to database — updates the receiver_type column.
 */
export function saveProbeResult(db: Database.Database, result: ProbeResult) {
  if (!result.success) return;

  const receiverType = result.receiver_descriptor ||
    (result.has_msm7 && result.constellations.length >= 4 ? "SURVEY_GRADE_PROBED" :
     result.has_msm7 && result.constellations.length >= 3 ? "PROFESSIONAL_PROBED" :
     result.has_msm5 ? "CONSUMER_GOOD_PROBED" : "CONSUMER_BASIC_PROBED");

  const antennaType = result.antenna_descriptor || "";

  try {
    db.prepare(`
      UPDATE stations SET receiver_type = ?, antenna_type = ?
      WHERE name = ? AND network = 'onocoy'
    `).run(receiverType, antennaType, result.station);
  } catch {}
}
