import "dotenv/config";
import { z } from "zod";

/**
 * Validação centralizada das variáveis de ambiente.
 * Falha rápido (fail-fast) no boot se algo essencial estiver ausente/ inválido.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  CORS_ORIGIN: z.string().default("*"),

  // Número de proxies confiáveis à frente da API (nginx/ELB = 1).
  // Necessário para o rate limit identificar o IP real do cliente.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(8, "JWT_SECRET deve ter ao menos 8 caracteres"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  BADGE_HASH_SECRET: z
    .string()
    .min(8, "BADGE_HASH_SECRET deve ter ao menos 8 caracteres"),
  BADGE_VERIFY_BASE_URL: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3", "supabase"]).default("local"),

  // Local driver
  LOCAL_STORAGE_DIR: z.string().default("uploads"),
  LOCAL_STORAGE_PUBLIC_URL: z
    .string()
    .default("http://localhost:3333/files"),

  // S3 driver
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  S3_PUBLIC_URL: z.string().optional(),

  // Supabase driver
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_BUCKET: z.string().optional(),

  // Email (Resend) — opcional; notificações desabilitadas se ausente
  RESEND_API_KEY: z.string().optional(),
  NOTIFICATION_FROM_EMAIL: z.string().default("notificacoes@accesshub.com.br"),

  // LGPD — criptografia de campos PII (CPF, RG).
  // Deve ser uma string hexadecimal de 64 caracteres (32 bytes = AES-256).
  // Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // Quando ausente: campos são armazenados em texto plano (modo legado).
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY deve ser uma string hex de 64 caracteres (32 bytes)")
    .optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error(
    "❌ Variáveis de ambiente inválidas:\n",
    z.treeifyError(parsed.error),
  );
  throw new Error("Falha ao carregar configuração de ambiente.");
}

export const env = parsed.data;
export type Env = typeof env;
