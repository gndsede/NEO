/**
 * Cache TTL genérico em memória. Um único processo (Railway roda 1
 * instância) então não precisa de Redis — só reduzir carga de consultas
 * agregadas pesadas, com contadores de hit/miss para o painel de
 * observabilidade (regra "Cache Hit/Miss Tracking").
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
}

export class TtlCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private stats: CacheStats = { hits: 0, misses: 0, sets: 0, evictions: 0 };

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      this.stats.evictions++;
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.stats.sets++;
  }

  /** Retorna do cache se presente/válido; senão computa, guarda e retorna. */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.store.size,
      hitRate:
        this.stats.hits + this.stats.misses === 0
          ? 0
          : this.stats.hits / (this.stats.hits + this.stats.misses),
    };
  }
}

/** Instância única compartilhada por todo o processo. */
export const cache = new TtlCache();
