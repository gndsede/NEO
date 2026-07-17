import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { env } from "../config/env.js";
import { rewritePublicUrl } from "./public-url.js";

/**
 * Assinatura HMAC de URLs de arquivos do storage local (/files).
 *
 * O banco continua armazenando a URL "crua" (estável, com host `localhost`
 * gravado no upload); a assinatura é aplicada na saída da API (ver app.ts),
 * junto da reescrita de host via `rewritePublicUrl` — usando o `Host` que o
 * cliente atual usou para alcançar a API — para que qualquer endpoint que
 * devolva um `fileUrl`/`photoUrl` funcione fora da máquina que rodou o
 * upload. Sem `sig` e `exp` válidos, a rota /files recusa a requisição.
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

// Caminho (ex.: "/files") usado para reconhecer URLs do storage local
// independentemente do host — cobre tanto a URL crua (`localhost`) quanto
// uma já reescrita para o host público por um caller anterior.
const localPath = new URL(env.LOCAL_STORAGE_PUBLIC_URL).pathname.replace(/\/$/, "");

/**
 * Reescreve o host (se for `localhost`/`127.0.0.1`) e assina uma URL do
 * storage local. URLs de outros provedores (S3/Supabase) ou já assinadas
 * passam intactas.
 */
export function signLocalFileUrl(
  url: string,
  req?: Request,
  ttlSeconds?: number,
): string {
  if (url.includes("sig=")) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.pathname.startsWith(`${localPath}/`)) return url;

  const key = decodeURIComponent(parsed.pathname.slice(localPath.length + 1));
  const { exp, sig } = signFilePath(key, ttlSeconds);

  const publicUrl = req ? (rewritePublicUrl(url, req) ?? url) : url;
  const sep = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${sep}exp=${exp}&sig=${sig}`;
}

/**
 * Percorre um payload JSON e assina toda string que seja URL do /files local.
 * Objetos não-planos (Date, Buffer, etc.) passam intactos.
 */
export function signFileUrlsDeep<T>(value: T, req?: Request): T {
  if (typeof value === "string") {
    return signLocalFileUrl(value, req) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => signFileUrlsDeep(item, req)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = signFileUrlsDeep(v, req);
      }
      return out as unknown as T;
    }
  }
  return value;
}
