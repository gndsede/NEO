import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Assinatura HMAC de URLs de arquivos do storage local (/files).
 *
 * O banco continua armazenando a URL "crua" (estável); a assinatura é aplicada
 * na saída da API (ver app.ts), com validade limitada. Sem `sig` e `exp`
 * válidos, a rota /files recusa a requisição — fotos e documentos deixam de
 * ser públicos.
 */

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h — suficiente para uma sessão de trabalho

function computeSignature(key: string, exp: number): string {
  return createHmac("sha256", env.JWT_SECRET)
    .update(`file|${key}|${exp}`)
    .digest("hex");
}

export function signFilePath(
  key: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { exp: number; sig: string } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return { exp, sig: computeSignature(key, exp) };
}

export function verifyFileSignature(
  key: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(computeSignature(key, exp), "hex");
  const provided = Buffer.from(sig, "hex");
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

const localBase = env.LOCAL_STORAGE_PUBLIC_URL.replace(/\/$/, "");

/**
 * Assina uma URL do storage local. URLs de outros provedores (S3/Supabase)
 * ou já assinadas passam intactas.
 */
export function signLocalFileUrl(url: string, ttlSeconds?: number): string {
  if (!url.startsWith(`${localBase}/`)) return url;
  if (url.includes("sig=")) return url;

  const withoutQuery = url.split("?")[0]!;
  const key = decodeURIComponent(withoutQuery.slice(localBase.length + 1));
  const { exp, sig } = signFilePath(key, ttlSeconds);
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}exp=${exp}&sig=${sig}`;
}

/**
 * Percorre um payload JSON e assina toda string que seja URL do /files local.
 * Objetos não-planos (Date, Buffer, etc.) passam intactos.
 */
export function signFileUrlsDeep<T>(value: T): T {
  if (typeof value === "string") {
    return signLocalFileUrl(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => signFileUrlsDeep(item)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = signFileUrlsDeep(v);
      }
      return out as unknown as T;
    }
  }
  return value;
}
