"use client";

/**
 * /ops/exports — download daily reports, filtered Excel exports, JSON dumps.
 *
 * Mirrors the old /agent "Exports" tab. Four download options:
 *   1. Daily report (date picker → Excel)            GET /api/agent/export/daily-report?date=YYYY-MM-DD
 *   2. Comprehensive Excel (filters)                  GET /api/agent/export/all-calls?status=&category=&date_from=&date_to=
 *   3. Today's report (one-click)                     GET /api/agent/export/daily-report?date=<today>
 *   4. All calls as JSON                              GET /api/agent/calls?page=1&page_size=200 (client-side blob download)
 *
 * Excel endpoints return an XLSX StreamingResponse — opening the URL in a
 * new tab triggers the browser download. We use window.location for in-tab
 * downloads (no popup blocker) and link clicks where appropriate.
 */

import * as React from "react";
import { opsFetch } from "@/lib/ops-fetch";
import {
  CalendarDays,
  Download,
  FileJson,
  FileSpreadsheet,
  Filter as FilterIcon,
  RefreshCw,
} from "lucide-react";

import { AppShell } from "@/components/shared/AppShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { API_URL } from "@/lib/api";

/* Mirror backend status / category lists for the filter dropdowns. */
const STATUS_OPTIONS = [
  "Pending", "Calling", "Called", "Called - Interested", "Called - Not Interested",
  "Not Answered", "Call Not Connected", "Failed", "Scheduled", "Invalid Phone",
] as const;
const CATEGORY_OPTIONS = [
  "Very Interested - Form Sent",
  "Interested - Callback Requested",
  "Interested - Needs Time to Decide",
  "Not Interested - Already Has Loan",
  "Not Interested - No Need Currently",
  "Ineligible - Income Too Low",
  "Ineligible - Business Too New",
  "Wrong Number / Not Reachable",
] as const;

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function OpsExportsPage() {
  const [dailyDate, setDailyDate] = React.useState(todayISO());
  const [status, setStatus] = React.useState<string>("all");
  const [category, setCategory] = React.useState<string>("all");
  const [dateFrom, setDateFrom] = React.useState<string>("");
  const [dateTo, setDateTo] = React.useState<string>("");
  const [jsonState, setJsonState] = React.useState<"idle" | "downloading" | "error">("idle");
  const [jsonError, setJsonError] = React.useState<string>("");

  const buildExportUrl = () => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (category !== "all") params.set("category", category);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", dateTo);
    const qs = params.toString();
    return `${API_URL}/api/agent/export/all-calls${qs ? `?${qs}` : ""}`;
  };

  const downloadDaily = () => {
    if (!dailyDate) return;
    window.location.href = `${API_URL}/api/agent/export/daily-report?date=${dailyDate}`;
  };

  const downloadAllCallsExcel = () => {
    window.location.href = buildExportUrl();
  };

  const downloadJson = async () => {
    setJsonState("downloading");
    setJsonError("");
    try {
      // Pull a big page; bumping page_size to the backend's max=200.
      const res = await opsFetch(`${API_URL}/api/agent/calls?page=1&page_size=200`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pusad_all_calls_${todayISO()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setJsonState("idle");
    } catch (e) {
      setJsonState("error");
      setJsonError((e as Error).message);
    }
  };

  const hasFilter = status !== "all" || category !== "all" || Boolean(dateFrom) || Boolean(dateTo);

  return (
    <AppShell
      title="Exports"
      subtitle="Download daily reports, comprehensive call data, and JSON dumps for offline analysis"
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* CARD 1 — Daily report by date */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <span className="badge-icon bg-info/10 text-info ring-info/20">
                <CalendarDays className="h-4 w-4" />
              </span>
              <div>
                <CardTitle className="text-base">Daily report</CardTitle>
                <CardDescription>
                  Excel file with every call from a specific day.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="block text-xs font-medium text-muted-foreground">
              Date
              <input
                type="date"
                value={dailyDate}
                onChange={(e) => setDailyDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <Button onClick={downloadDaily} disabled={!dailyDate} className="btn-solid w-full">
              <Download className="h-4 w-4" />
              Download Excel
            </Button>
            <Separator />
            <Button
              variant="outline"
              onClick={() => {
                setDailyDate(todayISO());
                window.location.href = `${API_URL}/api/agent/export/daily-report?date=${todayISO()}`;
              }}
              className="w-full"
            >
              <CalendarDays className="h-4 w-4" />
              Today&apos;s report (one-click)
            </Button>
          </CardContent>
        </Card>

        {/* CARD 2 — Comprehensive export with filters */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <span className="badge-icon bg-primary/10 text-primary ring-primary/20">
                <FileSpreadsheet className="h-4 w-4" />
              </span>
              <div>
                <CardTitle className="text-base">Comprehensive export</CardTitle>
                <CardDescription>
                  Filtered Excel with every field. Use for monthly reviews or
                  external analysts.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-muted-foreground">
                Status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="all">All statuses</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Category
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="all">All categories</option>
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                From
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                To
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
              </label>
            </div>
            {hasFilter && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <FilterIcon className="h-3 w-3" />
                <span>Active filters will be applied:</span>
                {status !== "all" && <Badge variant="secondary">{status}</Badge>}
                {category !== "all" && <Badge variant="secondary">{category}</Badge>}
                {dateFrom && <Badge variant="secondary">≥ {dateFrom}</Badge>}
                {dateTo && <Badge variant="secondary">≤ {dateTo}</Badge>}
              </div>
            )}
            <Button onClick={downloadAllCallsExcel} className="btn-solid w-full">
              <Download className="h-4 w-4" />
              Export filtered Excel
            </Button>
            {hasFilter && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStatus("all");
                  setCategory("all");
                  setDateFrom("");
                  setDateTo("");
                }}
                className="w-full"
              >
                Clear filters
              </Button>
            )}
          </CardContent>
        </Card>

        {/* CARD 3 — JSON dump */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-3">
              <span className="badge-icon bg-muted text-foreground ring-border">
                <FileJson className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <CardTitle className="text-base">JSON dump</CardTitle>
                <CardDescription>
                  Latest 200 calls as raw JSON. For ad-hoc scripting or feeding
                  into your own analyst notebook.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              onClick={downloadJson}
              disabled={jsonState === "downloading"}
              className="btn-solid"
            >
              {jsonState === "downloading" ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Generating…
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Download JSON
                </>
              )}
            </Button>
            {jsonState === "error" && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                Download failed: <span className="font-mono">{jsonError}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
