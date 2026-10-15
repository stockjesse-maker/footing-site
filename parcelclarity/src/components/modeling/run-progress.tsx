"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { advanceRun, cancelRun } from "@/app/actions/modeling";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";

/**
 * Drives a running bulk run: each call to the server prices a few seconds' worth of shipments and
 * returns the server's view of progress (the client never keeps its own cursor). Transient failures
 * back off (1 s → 30 s, six attempts) before the run shows as paused with a Resume button. While
 * the run is still going, only counts are shown; averages appear when every order is priced.
 */
export function RunProgress({ runId, brandId, initial }: { runId: string; brandId?: string; initial: { processed: number; total: number; status: string } }) {
  const router = useRouter();
  const [progress, setProgress] = useState(initial);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchMs, setBatchMs] = useState<number | null>(null);
  const [batchSize, setBatchSize] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const attempts = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (paused || progress.status !== "running" || inFlight.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = async () => {
      inFlight.current = true;
      const before = progress.processed;
      const response = await advanceRun(runId, brandId);
      inFlight.current = false;
      if (cancelled) return;
      if (!response.ok) {
        if (!response.retryable || attempts.current >= 6) {
          setPaused(true);
          setError(response.message);
          return;
        }
        attempts.current += 1;
        const delay = Math.min(30_000, 1000 * 2 ** attempts.current) + Math.random() * 500;
        setError(`${response.message} Retrying…`);
        timer = setTimeout(() => setTick((t) => t + 1), delay);
        return;
      }
      attempts.current = 0;
      setError(null);
      setBatchMs(response.progress.batchMs);
      setBatchSize(response.progress.processed - before);
      setProgress({ processed: response.progress.processed, total: response.progress.total, status: response.progress.status });
      if (response.progress.status !== "running") {
        router.refresh();
        return;
      }
      timer = setTimeout(() => setTick((t) => t + 1), 50);
    };
    void step();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `tick` re-arms the loop after each batch or back-off; the other deps identify the run.
  }, [tick, paused, progress.status, progress.processed, runId, brandId, router]);

  const pct = progress.total ? Math.floor((progress.processed / progress.total) * 100) : 0;
  const remaining = batchMs && batchSize && batchSize > 0 ? Math.ceil(((progress.total - progress.processed) / batchSize) * (batchMs / 1000)) : null;
  const done = progress.status !== "running";

  return (
    <Card>
      <CardTitle>{done ? "Finishing up…" : "Pricing your orders"}</CardTitle>
      <CardDescription>
        {progress.processed.toLocaleString("en-US")} of {progress.total.toLocaleString("en-US")} shipments priced
        {remaining !== null && !done ? ` · about ${remaining < 60 ? `${remaining} seconds` : `${Math.ceil(remaining / 60)} minutes`} left` : ""}
      </CardDescription>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Shipments priced">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-3 text-sm text-muted">Keep this page open. If you switch apps on your phone the run pauses and resumes when you come back. Averages appear once every order is priced.</p>
      {error ? (
        <Alert tone={paused ? "danger" : "warning"} className="mt-4">
          {error}
        </Alert>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {paused ? (
          <Button
            onClick={() => {
              attempts.current = 0;
              setError(null);
              setPaused(false);
              setTick((t) => t + 1);
            }}
          >
            Resume
          </Button>
        ) : null}
        {!done ? (
          <Button
            variant="ghost"
            className="min-h-11 sm:min-h-9"
            onClick={async () => {
              setPaused(true);
              await cancelRun(runId, brandId);
              router.refresh();
            }}
          >
            Cancel run
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
