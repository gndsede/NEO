import type { Request } from "express";

/**
 * Reescreve URLs do storage local (`http://localhost:3333/...` ou `127.0.0.1`)
 * para usar o host pelo qual o cliente atual alcançou a API.
 *
 * Por que: quando o admin faz upload de foto, o backend grava
 * `http://localhost:3333/files/...` no banco. Esse domínio só funciona quando
 * o cliente roda na mesma máquina; mobile e tablets em LAN não alcançam
 * `localhost`. Em vez de exigir reconfiguração do env, traduzimos na hora
 * da resposta usando o `Host` que o próprio cliente usou.
 */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0"];

export function rewritePublicUrl(
  url: string | null | undefined,
  req: Request,
): string | null {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (!LOCAL_HOSTS.includes(parsed.hostname)) return url;

  const requestHost = req.headers.host;
  if (!requestHost) return url;

  const requestHostname = requestHost.split(":")[0];
  if (LOCAL_HOSTS.includes(requestHostname)) return url;

  const protocol =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  return `${protocol}://${requestHost}${parsed.pathname}${parsed.search}`;
}
