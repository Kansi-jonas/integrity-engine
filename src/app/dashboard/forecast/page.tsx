"use client";

import { useEffect, useState } from "react";
import {
  Loader2, RefreshCw, ArrowLeft, Clock, Sun, CloudLightning,
  Satellite, Droplets, AlertTriangle, CheckCircle2, TrendingDown,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import Link from "next/link";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ForecastPoint {
  hours_ahead: number;
  predicted_fix_rate: number;
  confidence_low: number;
  confidence_high: number;
  kp_expected: number;
  iono_risk: string;
  tropo_risk: string;
  constellation_alerts: string[];
  factors: string[];
}

interface ForecastData {
  lat: number;
  lon: number;
  current: ForecastPoint;
  forecast: ForecastPoint[];
  generated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RISK_COLORS: Record<string, { bg: string; text: string }> = {
  nominal: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700" },
  elevated: { bg: "bg-amber-50 border-amber-200", text: "text-amber-700" },
  degraded: { bg: "bg-orange-50 border-orange-200", text: "text-orange-700" },
  storm: { bg: "bg-red-50 border-red-200", text: "text-red-700" },
  low: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700" },
  medium: { bg: "bg-amber-50 border-amber-200", text: "text-amber-700" },
  high: { bg: "bg-red-50 border-red-200", text: "text-red-700" },
};

function RiskBadge({ label, risk }: { label: string; risk: string }) {
  const cfg = RISK_COLORS[risk] || RISK_COLORS.nominal;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${cfg.bg} ${cfg.text}`}>
      {label}: {risk}
    </span>
  );
}

// ─── Locations ──────────────────────────────────────────────────────────────

const LOCATIONS = [
  { name: "Frankfurt (EU Central)", lat: 50.1, lon: 8.7 },
  { name: "Berlin", lat: 52.5, lon: 13.4 },
  { name: "London", lat: 51.5, lon: -0.1 },
  { name: "New York (US East)", lat: 40.7, lon: -74.0 },
  { name: "Los Angeles (US West)", lat: 34.1, lon: -118.2 },
  { name: "Sydney (APAC)", lat: -33.9, lon: 151.2 },
  { name: "Antwerp (Port)", lat: 51.2, lon: 4.4 },
  { name: "Rotterdam", lat: 51.9, lon: 4.5 },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function ForecastPage() {
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState(LOCATIONS[0]);

  const fetchForecast = (loc: typeof LOCATIONS[0]) => {
    setLoading(true);
    fetch(`/api/forecast?lat=${loc.lat}&lon=${loc.lon}&hours=1,3,6,12,24`)
      .then(r => r.json())
      .then(d => setForecast(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchForecast(selectedLocation); }, [selectedLocation]);

  const chartData = forecast ? [
    { name: "Now", fix: forecast.current.predicted_fix_rate, low: forecast.current.confidence_low, high: forecast.current.confidence_high },
    ...forecast.forecast.map(f => ({
      name: `+${f.hours_ahead}h`,
      fix: f.predicted_fix_rate,
      low: f.confidence_low,
      high: f.confidence_high,
    })),
  ] : [];

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-[1200px] mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <Link href="/dashboard" className="text-[13px] text-[var(--color-brand)] hover:underline flex items-center gap-1 mb-1">
              <ArrowLeft className="h-3 w-3" /> Dashboard
            </Link>
            <h1 className="text-[18px] sm:text-[20px] font-semibold text-[var(--color-text-primary)]">Quality Forecast</h1>
            <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">
              Predicted GNSS quality 1-24h ahead based on space weather, ionosphere, and station health
            </p>
          </div>
        </div>

        {/* Location Selector */}
        <div className="flex flex-wrap gap-2">
          {LOCATIONS.map(loc => (
            <button
              key={loc.name}
              onClick={() => setSelectedLocation(loc)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition border ${
                selectedLocation.name === loc.name
                  ? "bg-[var(--color-brand)] text-white border-[var(--color-brand)]"
                  : "bg-white text-[var(--color-text-secondary)] border-[var(--color-border)] hover:bg-[var(--color-gray-50)]"
              }`}
            >
              {loc.name}
            </button>
          ))}
        </div>

        {loading && !forecast ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--color-gray-300)]" />
          </div>
        ) : forecast ? (
          <>
            {/* Current + Forecast KPIs */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-xl border border-[var(--color-border)] bg-white p-5 shadow-[var(--shadow-xs)]">
                <div className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider mb-2">Current Fix Rate</div>
                <div className="text-[28px] font-semibold text-[var(--color-text-primary)] tabular-nums">{forecast.current.predicted_fix_rate}%</div>
                <div className="flex gap-2 mt-2">
                  <RiskBadge label="Iono" risk={forecast.current.iono_risk} />
                  <RiskBadge label="Tropo" risk={forecast.current.tropo_risk} />
                </div>
              </div>

              {forecast.forecast.slice(0, 3).map(f => (
                <div key={f.hours_ahead} className="rounded-xl border border-[var(--color-border)] bg-white p-5 shadow-[var(--shadow-xs)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Clock className="h-3.5 w-3.5 text-[var(--color-gray-400)]" />
                    <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)] uppercase tracking-wider">+{f.hours_ahead}h Forecast</span>
                  </div>
                  <div className="text-[28px] font-semibold text-[var(--color-text-primary)] tabular-nums">{f.predicted_fix_rate}%</div>
                  <div className="text-[12px] text-[var(--color-text-tertiary)] mt-1">
                    Range: {f.confidence_low}% – {f.confidence_high}%
                  </div>
                  <div className="flex gap-2 mt-2">
                    <RiskBadge label="Iono" risk={f.iono_risk} />
                  </div>
                </div>
              ))}
            </div>

            {/* Forecast Chart */}
            <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
              <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
                <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Fix Rate Forecast — {selectedLocation.name}</h2>
                <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">Predicted fix rate with confidence bands</p>
              </div>
              <div className="p-5">
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-gray-200)" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11, fill: "var(--color-gray-500)" }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "var(--color-gray-500)" }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                    <Tooltip
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid var(--color-border)",
                        boxShadow: "var(--shadow-sm)",
                        fontSize: "13px",
                      }}
                      formatter={(value: any, name: any) => [
                        `${value}%`,
                        name === "fix" ? "Predicted" : name === "low" ? "Low" : "High",
                      ]}
                    />
                    <Area type="monotone" dataKey="high" stackId="confidence" stroke="none" fill="#0067ff" fillOpacity={0.06} />
                    <Area type="monotone" dataKey="low" stackId="confidence" stroke="none" fill="#ffffff" fillOpacity={1} />
                    <Area type="monotone" dataKey="fix" stroke="#0067ff" fill="#0067ff" fillOpacity={0.12} strokeWidth={2}
                      dot={{ r: 4, fill: "#0067ff", stroke: "#ffffff", strokeWidth: 2 }}
                      activeDot={{ r: 6, fill: "#0067ff", stroke: "#ffffff", strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Factors */}
            {forecast.forecast.some(f => f.factors.length > 0) && (
              <div className="rounded-xl border border-[var(--color-border)] bg-white shadow-[var(--shadow-xs)]">
                <div className="px-5 py-4 border-b border-[var(--color-border-light)]">
                  <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Quality Factors</h2>
                  <p className="text-[13px] text-[var(--color-text-secondary)] mt-0.5">Conditions affecting predicted quality</p>
                </div>
                <div className="p-5 space-y-3">
                  {forecast.forecast.filter(f => f.factors.length > 0).map(f => (
                    <div key={f.hours_ahead} className="flex items-start gap-3">
                      <span className="text-[13px] font-medium text-[var(--color-text-primary)] w-16 shrink-0">+{f.hours_ahead}h</span>
                      <div className="flex flex-wrap gap-2">
                        {f.factors.map((factor, i) => (
                          <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] bg-[var(--color-gray-50)] text-[var(--color-text-secondary)] border border-[var(--color-border-light)]">
                            <AlertTriangle className="h-3 w-3 text-amber-500" />
                            {factor}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Constellation Alerts */}
            {forecast.forecast.some(f => f.constellation_alerts.length > 0) && (
              <div className="rounded-xl border border-[var(--color-danger-muted)] bg-[var(--color-danger-muted)] shadow-[var(--shadow-xs)]">
                <div className="px-5 py-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Satellite className="h-4 w-4 text-[var(--color-danger)]" />
                    <h3 className="text-[14px] font-semibold text-[var(--color-danger)]">Constellation Alerts</h3>
                  </div>
                  <div className="space-y-1">
                    {[...new Set(forecast.forecast.flatMap(f => f.constellation_alerts))].map((alert, i) => (
                      <p key={i} className="text-[13px] text-red-800">{alert}</p>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] bg-white p-12 text-center shadow-[var(--shadow-xs)]">
            <Clock className="h-10 w-10 text-[var(--color-gray-300)] mx-auto mb-3" />
            <p className="text-[14px] text-[var(--color-text-secondary)]">Select a location to see quality forecast</p>
          </div>
        )}

        <p className="text-[11px] text-[var(--color-text-tertiary)] text-center">
          {forecast?.generated_at ? `Generated: ${new Date(forecast.generated_at).toLocaleString("de-DE")}` : ""}
        </p>
      </div>
    </div>
  );
}
