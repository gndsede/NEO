import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm" as const;
const IV_LEN = 12;
const TAG_LEN = 16;

function rawKey(): Buffer | null {
  const hex = env.ENCRYPTION_KEY;
  if (!hex || hex.length < 64) return null;
  return Buffer.from(hex.slice(0, 64), "hex");
}

/**
 * Criptografa uma string com AES-256-GCM.
 * Retorna base64(iv || tag || ciphertext).
 * Quando ENCRYPTION_KEY não está configurada, retorna o texto como está (modo legado).
 */
export function encrypt(plaintext: string): string {
  const key = rawKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const out = Buffer.alloc(IV_LEN + TAG_LEN + encrypted.length);
  iv.copy(out, 0);
  tag.copy(out, IV_LEN);
  encrypted.copy(out, IV_LEN + TAG_LEN);
  return out.toString("base64");
}

/**
 * Decripta um valor criado por encrypt().
 * Se ENCRYPTION_KEY não estiver configurada, retorna o texto como está.
 * Se a decriptação falhar (ex.: campo ainda em texto plano), retorna o valor original.
 */
export function decrypt(ciphertext: string): string {
  const key = rawKey();
  if (!key) return ciphertext;

  try {
    const buf = Buffer.from(ciphertext, "base64");
    if (buf.length < IV_LEN + TAG_LEN + 1) return ciphertext;

    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = buf.subarray(IV_LEN + TAG_LEN);

    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data).toString("utf8") + decipher.final("utf8");
  } catch {
    // Campo ainda em texto plano (registrado antes da ativação da chave)
    return ciphertext;
  }
}

/**
 * Gera um hash determinístico do CPF para uso como índice único.
 * O CPF é normalizado (somente dígitos) antes do hash.
 * Usa HMAC-SHA256 quando ENCRYPTION_KEY está configurada, ou SHA256 simples.
 * Este valor NÃO revela o CPF original — apenas permite busca exata.
 */
export function hashCpf(cpf: string): string {
  const normalized = cpf.replace(/\D/g, "");
  const key = env.ENCRYPTION_KEY;
  if (key && key.length >= 64) {
    return createHmac("sha256", Buffer.from(key.slice(0, 64), "hex"))
      .update(normalized)
      .digest("hex");
  }
  // Sem chave: SHA256 puro (ainda não-reversível)
  return createHash("sha256").update(normalized).digest("hex");
}
