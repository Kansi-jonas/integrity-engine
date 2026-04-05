# MERIDIAN — RTKdata Integrity Engine

> **Spatial Intelligence Engine fuer zentimetergenaue GNSS-Positionierung**
> Kansi Solutions GmbH | Version 3.0 | April 2026

---

## 1. Was MERIDIAN macht

MERIDIAN aggregiert Korrekturdaten von 20.000+ GNSS-Basisstationen (GEODNET + ONOCOY) in 145+ Laendern und routet Benutzer automatisch zur optimalen Station. Das System ist selbstoptimierend: Session-Feedback und Alberding-Caster-Logs fliessen zurueck in Qualitaetsbewertung und Stationsauswahl.

**Kernprinzip:** 1 Globaler GEODNET-Mountpoint (AUTO) als universeller Fallback + N ONOCOY-Overlay-Zonen nur dort wo GEODNET echte Luecken hat (>40km). GEODNET ist immer primaer. ONOCOY ist chirurgisches Gap-Fill.

**Ergebnis:** Eine ntrips.cfg fuer Alberding NTRIP Caster mit ~500 Zonen, automatischem Failover, und Quality Gates — deployed auf 3 AWS-Instanzen (EU Frankfurt, US East, APAC Sydney).

---

## 2. Tech Stack

| Komponente | Technologie |
|------------|------------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Sprache | TypeScript 5.9 |
| Datenbank | SQLite (better-sqlite3, WAL mode) |
| UI | React 19, Recharts, Leaflet, Radix UI, Tailwind CSS 4 |
| State | Zustand |
| Spatial | H3-js (Hexagonal Grid), Haversine |
| ML | ml-random-forest, ml-matrix |
| Deployment | Docker → Render.com (Auto-Deploy via Git) |
| Caster | Alberding NTRIP Caster (3x AWS EC2) |
| SSH | ssh2 (Node.js) fuer Multi-Caster Deploy |
| Scheduling | node-cron |

---

## 3. Architektur

### 3.1 Datenquellen

| Quelle | Endpunkt | Daten | Intervall |
|--------|----------|-------|-----------|
| RTKBI API | `RTKBI_URL/api/sessions` | Historische RTK Sessions | Alle 2h |
| GEODNET API | `GEODNET_APP_ID/KEY` | Live Sessions + Stationsmetadaten | Alle 5 Min |
| Alberding Logs | SSH → `/var/log/ntrips/` | Access Logs (CSV) | Alle 4h |
| ONOCOY NTRIP | `clients.onocoy.com:2101` | RTCM 1033 Probe (Hardware-ID) | Einmalig/Station |
| NOAA/DSCOVR | Diverse APIs | Kp, Dst, Solar Wind, Flares | Stuendlich |

### 3.2 Agenten-Pipeline (19 Agents)

| Agent | Datei | Intervall | Funktion |
|-------|-------|-----------|----------|
| GEODNET Session Sync | auto-sync.ts | 5 Min | Sessions von GEODNET API |
| RTKBI Historical Sync | auto-sync.ts | 2h | Historische Sessions via RTKBI |
| Station Sync | auto-sync.ts | 2h | GEODNET + ONOCOY Metadaten |
| Status Snapshot | auto-sync.ts | 15 Min | Uptime-Historie |
| **SENTINEL V2** | agents/sentinel-v2.ts | 5 Min | CUSUM/EWMA/ST-DBSCAN Anomalien |
| **SHIELD** | agents/shield.ts | 5 Min (+2s) | 16-Feature Interferenzklassifikation |
| **Predictive Failover** | agents/predictive-failover.ts | 15 Min | Trend-basierte Fruehwarnung |
| **Environment** | agents/environment.ts | 1h | 9-Quellen Space Weather |
| **Network Health** | network-health.ts | 1h | Komposit-Score (Q/R/C/F) |
| **TRUST V2** | agents/trust-v2.ts | 4h (Pipeline) | Bayesian Beta Trust Scoring |
| **H3 Quality** | h3-quality.ts | 4h (Pipeline) | 5-Komponenten Coverage Quality |
| **Zone Builder V3** | zone-builder-v2.ts | 4h (Pipeline) | Survey-Grade Overlays in GEODNET-Gaps |
| **Fence Generator V3** | agents/fence-generator.ts | 4h (Pipeline) | Anti-Flapping + SHIELD Override |
| **Config Engine** | wizard/config-engine.ts | 4h (Pipeline) | Alberding ntrips.cfg Generator |
| **Session Feedback** | agents/session-feedback.ts | 4h (Pipeline) | ONOCOY Validierung (Promotion/Rejection) |
| **Cross-Validator** | agents/cross-validator.ts | 4h (Pipeline) | GEODNET vs ONOCOY Konsistenz |
| **Adversarial Detector** | agents/adversarial-detector.ts | 4h (Pipeline) | DePIN Gaming Detection |
| **Coverage Optimizer** | agents/coverage-optimizer.ts | 4h (Pipeline) | H3 Gap-Analyse |
| **Thompson Sampling** | thompson-sampling.ts | 4h (Pipeline) | Bayesian Explore/Exploit Routing |
| **Log Feedback** | agents/log-feedback.ts | 4h (Pipeline) | Alberding Logs → Trust Update |
| **ONOCOY Gap-Fill** | agents/onocoy-gapfill.ts | 4h (Pipeline) | Hardware-basierte Gap-Analyse |
| **RTCM Probe** | agents/rtcm-probe.ts | Background | RTCM 1033 Hardware Detection |

### 3.3 Closed-Loop Self-Optimization

```
RTKBI API → Sessions → SENTINEL/TRUST/H3 → Zone Builder V3 → Config Engine
  → Alberding Caster → User Sessions → Alberding Logs
  → Log Feedback → Trust Update → Loop
```

---

## 4. Zone Builder V3

### Konstanten

| Konstante | Wert | Beschreibung |
|-----------|------|-------------|
| GEODNET_ABSENT_KM | 40 km | ONOCOY nur wo kein GEODNET innerhalb 40km |
| MAX_OVERLAYS | 500 | Max Overlay-Zonen |
| MAX_OVERLAY_RADIUS_M | 45.000 m | RTK-physikalisches Limit |
| DEFAULT_OVERLAY_RADIUS_M | 35.000 m | Standard-Radius |
| MIN_OVERLAY_RADIUS_M | 15.000 m | Minimum |
| DEDUP_DISTANCE_KM | 5 km | Gleicher Standort |
| SURVEY_GRADE_MIN_CONFIDENCE | 0.70 | Hardware-Filter |
| PROFESSIONAL_MIN_CONFIDENCE | 0.65 | Professional-Filter |
| CONSUMER_MIN_CONFIDENCE | 0.50 | Consumer nur wenn confirmed |
| PROFESSIONAL_MIN_GAP_KM | 60 km | Professional nur in grossen Gaps |
| CONSUMER_MIN_GAP_KM | 80 km | Consumer nur in sehr grossen Gaps |

### 3 Strategien

1. **Survey-Grade** (Conf >= 0.70): In jeder GEODNET-Luecke >40km → Priority 5 (Primary)
2. **Professional** (Conf >= 0.65): Nur in Luecken >60km → Priority 30 (Failover)
3. **Consumer** (Conf >= 0.50): Nur wenn confirmed + Luecke >80km → Priority 30

### Overlap-Merge

Union-Find mit Spatial Grid (1.0 Grad). Ueberlappende Circles → Convex Hull Polygon mit 45km Buffer. Cluster-Extent > 200km → individuelle Circles (verhindert Monster-Polygone). Geographic Diversity: Round-Robin ueber 10-Grad Grid bei Cap.

---

## 5. H3 Quality Engine

**5-Komponenten-Scoring pro H3 Hexagon (Resolution 5, ~8.5km):**

| Komponente | Gewicht | Formel |
|------------|---------|--------|
| Baseline | 0.35 | exp(-(d/20)^2) Gaussian Decay, sigma=20km |
| Geometry | 0.20 | Bearing-Gap + Station Count |
| Uptime | 0.20 | 7-Tage Rolling Average |
| Freshness | 0.15 | max(0, 1 - age/10) |
| Fix Rate | 0.10 | Beobachtete Session-Daten |

**Tiers:** full_rtk >= 0.75, degraded 0.50-0.75, float 0.25-0.50, no_coverage < 0.25

---

## 6. TRUST V2

**Bayesian Beta-Verteilung** (Alpha/Beta) + **5-Komponenten Composite** (0.30 Quality, 0.20 Uptime, 0.20 Consistency, 0.15 History, 0.15 Distance).

**Blend:** 0.6 * Bayesian + 0.4 * Composite

**Hysterese:** Exclude < 0.25, Restore >= 0.55 (Standard 24h), Fast-Track >= 0.70 (6h).

**Temporal Decay:** 0.995 pro 4h-Zyklus.

---

## 7. SENTINEL V2

**Kp-adaptive Schwellen:**

| Kp | CUSUM H | CUSUM K | EWMA Fix-Drop | EWMA Age |
|----|---------|---------|---------------|----------|
| >= 7 | 8.0 | 0.75 | 30% | 5.0s |
| 5-6 | 6.5 | 0.60 | 22% | 4.0s |
| 4 | 5.5 | 0.55 | 18% | 3.5s |
| < 4 | 5.0 | 0.50 | 15% | 3.0s |

**ST-DBSCAN:** Spatial 30km, Temporal 10min, MinPts 3.

---

## 8. SHIELD

**6 Interferenz-Typen:** Jamming, Spoofing, Ionosphaerisch, Station Fault, Multipath, Network.
**16 Features** → Rule-Based Classifier → Confidence = min(0.95, bestScore/totalScore).
**Severity:** critical (>=8 users oder Jamming), warning (>=4), info (<4).

---

## 9. Fence Generator V3 (Meridian Fixes)

| Konstante | Wert | Beschreibung |
|-----------|------|-------------|
| ANTI_FLAPPING_MIN_HOURS | 6h | Min Zonenlebensdauer |
| MAX_ACTIONS_PER_CYCLE | 20 | Cascade-Exhaustion-Guard |
| SHIELD_OVERRIDE_CONFIDENCE | 0.60 | SHIELD > Anti-Flapping |
| DOWNGRADE_TRUST_THRESHOLD | 0.50 | Zone Priority +20 |
| EXCLUDE_TRUST_THRESHOLD | 0.30 | Zone deaktivieren |
| RESTORE_TRUST_THRESHOLD | 0.70 | Zone wiederherstellen |

**Meridian Formal Verification Fixes:**
1. **Cascade-Exhaustion-Alert:** >20 Aktionen/Zyklus = systemisches Problem
2. **SHIELD Override:** Jamming/Spoofing (Conf >= 0.60) bypassed Anti-Flapping
3. **Dual-Outage:** >10 GEODNET + >5 ONOCOY excluded = Alert
4. **Anti-Flapping:** 6h > 4h Regeneration (Design-Entscheidung)
5. **Trust Fast-Track:** 6h statt 24h bei Score >= 0.70

---

## 10. Alberding Log Feedback

**Closed-Loop:** Caster Logs (CSV) → caster-log-ingest → log-feedback → Trust Update.

| Konstante | Wert |
|-----------|------|
| Duration Target | 1800s (30 Min) |
| Data Rate Target | 500 bytes/s |
| Stability Weight | 0.70 |
| Data Rate Weight | 0.30 |
| Trust Update Weight | 0.30 |
| Circuit Breaker | 50% Stationen instabil → skip |

**Fix-Rate-Schaetzung aus Logs:** >300s = 80%, >60s = 60%, <60s = 30%.

---

## 11. Config Engine (Alberding ntrips.cfg)

**3-Tier:** Network (Host:Port) → NetworkMountpoint (AUTO, NRBY_ADV) → RTKdata Mountpoint (SMART).

**smarker:** overlap(5000), tryrestart(1). GEOD_AUTO ist immer erstes Child (hoechste Prioritaet).

**Geofence:** circle(radius,lat,lon) oder polygon(lat1,lon1,...). Max 6 Dezimalstellen, Fixed-Point.

**Credential Masking:** `/[^:\n]+:[^@\n]+@/g` (verhindert Cross-Line-Matching).

---

## 12. Config Safety

7 Checks: not_empty, min_streams (>=5), has_users, size_check (<=10MB), syntax_check, geofence_syntax, onocoy_urls (clients.onocoy.com). Rollback: letzte 5 Configs gespeichert.

---

## 13. Thompson Sampling

Exploration Weight 0.70 (PhD-reviewed). Safety Clamp +0.15 max. Excluded Stations werden nie gesampelt. Joehnk-Algorithmus fuer Alpha/Beta < 1, Cheng BC fuer >= 1.

---

## 14. Network Health Score

**NHS = 0.40 * Quality + 0.25 * Reliability + 0.20 * Coverage + 0.15 * Freshness**

Grades: Excellent (>=90), Good (80-89), Acceptable (70-79), Degraded (60-69), Critical (<60).

---

## 15. Multi-Caster Deployment

3 AWS-Instanzen (EU/US/APAC). SSH/SFTP Upload + kill -HUP (Zero-Downtime Reload). Config Safety Check vor Deploy. Rollback immer verfuegbar. SSH Timeout 30s.

---

## 16. Dashboard

**Stripe-Design** (DM Sans, warm grays). 20+ Pages:

- Overview (KPIs, Map, Anomalies, Trust, Fences)
- Coverage Quality (H3 Hexagons + Overlay Map)
- Station Trust (Beta Distribution + Table)
- Interference (SHIELD Events)
- Forecast (Quality Prediction)
- Config (Quality Gates + Deploy)
- System Status (DB, Pipeline, Probe)
- Wizard (11 CRUD Pages: Zones, Networks, Mountpoints, Users, Groups, etc.)

---

## 17. API (51 Endpoints)

- `/api/quality` — H3 Cells + Overlays
- `/api/trust` — Station Trust Scores
- `/api/anomalies` — Signal Integrity
- `/api/interference` — SHIELD Events
- `/api/config/preview` — ntrips.cfg (masked)
- `/api/trigger?pipeline=quality` — Manual Pipeline Trigger
- `/api/monitor?section=X` — 10-Section Monitoring
- `/api/probe?action=start/stop/status` — ONOCOY Probe
- `/api/wizard/data/[entity]` — 11 Wizard CRUD Routes
- `/api/wizard/deploy` — SSH Deploy
- `/api/public/dashboard` — Sanitized Public API

---

## 18. Datenbank (SQLite)

| Tabelle | Zweck |
|---------|-------|
| rtk_sessions | GEODNET Session-Daten |
| stations | Station Snapshot (25.000+) |
| station_status_log | 15-Min Uptime Snapshots |
| station_scores | UQ + Reliability Scores |
| quality_cells | H3 Hexagon Quality (90.000+) |
| zone_definitions | Zone Boundaries |
| sync_log | Sync History |
| audit_log | Compliance Log |
| interference_events | SHIELD Events |

**Pragmas:** journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000ms.

---

## 19. Formale Verifikation (Meridian Rule Check)

26 Regeln formalisiert als temporallogische Formeln (Nexus Tau / IDNI Tau Language). 10 Spannungsszenarien untersucht. 3 strukturelle Erkenntnisse + 10 offene Fragen — alle implementiert.

**12 System-Invarianten:**
1. GEODNET immer primaer (Priority 10)
2. Config hat immer >= 5 Streams
3. Rollback existiert immer nach Deploy
4. Zone-Modifikation max 1x/6h (ausser SHIELD)
5. Excluded Station bleibt min 6h
6. Max 20 Fence-Aktionen pro Zyklus
7. Pipeline-Zyklen ueberlappen nie
8. ONOCOY nur in GEODNET-Luecken (>40km)
9. Consumer ONOCOY nur wenn confirmed
10. Credentials nie im Dashboard sichtbar
11. Alle 3 Caster erhalten identische Config
12. SHIELD Jamming/Spoofing > Anti-Flapping

**Vollstaendige Spezifikation:** `MERIDIAN_Systemspezifikation_v3.docx`

---

## 20. Environment Variables

Siehe `.env.example` — 27 Variablen dokumentiert.

Kritisch: `AUTH_USER`, `AUTH_PASS` (Default-Deny), `GEODNET_APP_ID/KEY`, `ONOCOY_USER/PASS`.

---

## 21. Deployment

- **Render.com:** Auto-Deploy via Git Push auf `main`
- **Docker:** node:22-slim, Multi-Stage Build
- **Start:** `npm start -- -p ${PORT:-3001}`
- **Persistent Disk:** 5GB auf `/data/integrity.db`
- **Build:** ~2 Min (Turbopack), 0 TS Errors
