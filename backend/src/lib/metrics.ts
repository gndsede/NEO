/**
 * Métricas de performance em memória: por rota (janela deslizante) e
 * snapshots periódicos de processo (memória/CPU/throughput/erro).
 */

const REQUEST_WINDOW_MS = 5 * 60 * 1000; // 5 min
const SNAPSHOT_HISTORY_SIZE = 60; // 60 amostras (1h com sampler de 60s)

interface RequestRecord {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  at: number;
}

export interface MetricSnapshotData {
  takenAt: string;
  rssMb: number;
  heapUsedMb: number;
  cpuUserPct: number;
  requestsPerMin: number;
  avgLatencyMs: number;
  errorRate: number;
}

class RequestMetrics {
  private records: RequestRecord[] = [];
  private snapshots: MetricSnapshotData[] = [];
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = Date.now();

  record(entry: { route: string; method: string; status: number; durationMs: number }): void {
    this.records.push({ ...entry, at: Date.now() });
    this.pruneOldRecords();
  }

  private pruneOldRecords(): void {
    const cutoff = Date.now() - REQUEST_WINDOW_MS;
    while (this.records.length > 0 && this.records[0].at < cutoff) {
      this.records.shift();
    }
  }

  /** Stats agregadas por rota, na janela dos últimos 5 min. */
  getRouteStats() {
    this.pruneOldRecords();
    const byRoute = new Map<string, RequestRecord[]>();
    for (const r of this.records) {
      const key = `${r.method} ${r.route}`;
      const list = byRoute.get(key) ?? [];
      list.push(r);
      byRoute.set(key, list);
    }

    return [...byRoute.entries()]
      .map(([route, list]) => {
        const durations = list.map((r) => r.durationMs).sort((a, b) => a - b);
        const p95Index = Math.min(
          Math.floor(durations.length * 0.95),
          durations.length - 1,
        );
        const errors = list.filter((r) => r.status >= 500).length;
        return {
          route,
          count: list.length,
          avgMs: durations.reduce((s, d) => s + d, 0) / durations.length,
          p95Ms: durations[p95Index] ?? 0,
          errorCount: errors,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  /** Stats agregadas de todas as rotas, na janela dos últimos 5 min. */
  getOverallStats() {
    this.pruneOldRecords();
    const durations = this.records.map((r) => r.durationMs).sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(durations.length * 0.95), durations.length - 1);
    const errors = this.records.filter((r) => r.status >= 500).length;
    return {
      count: this.records.length,
      avgMs:
        durations.length === 0 ? 0 : durations.reduce((s, d) => s + d, 0) / durations.length,
      p95Ms: durations.length === 0 ? 0 : durations[p95Index],
      errorRate: this.records.length === 0 ? 0 : errors / this.records.length,
    };
  }

  /** Amostra o processo (memória/CPU) e a janela atual de requests. Chamado pelo sampler periódico. */
  takeSnapshot(): MetricSnapshotData {
    this.pruneOldRecords();
    const mem = process.memoryUsage();

    const cpuNow = process.cpuUsage();
    const nowMs = Date.now();
    const elapsedMs = nowMs - this.lastCpuAt || 1;
    const userDeltaUs = cpuNow.user - this.lastCpuUsage.user;
    const cpuUserPct = (userDeltaUs / 1000 / elapsedMs) * 100;
    this.lastCpuUsage = cpuNow;
    this.lastCpuAt = nowMs;

    const windowMinutes = REQUEST_WINDOW_MS / 60_000;
    const errors = this.records.filter((r) => r.status >= 500).length;

    const snapshot: MetricSnapshotData = {
      takenAt: new Date().toISOString(),
      rssMb: mem.rss / (1024 * 1024),
      heapUsedMb: mem.heapUsed / (1024 * 1024),
      cpuUserPct: Math.max(0, cpuUserPct),
      requestsPerMin: this.records.length / windowMinutes,
      avgLatencyMs:
        this.records.length === 0
          ? 0
          : this.records.reduce((s, r) => s + r.durationMs, 0) / this.records.length,
      errorRate: this.records.length === 0 ? 0 : errors / this.records.length,
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > SNAPSHOT_HISTORY_SIZE) this.snapshots.shift();
    return snapshot;
  }

  getSnapshotHistory(): MetricSnapshotData[] {
    return this.snapshots;
  }

  getLatestSnapshot(): MetricSnapshotData | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }
}

export const requestMetrics = new RequestMetrics();
