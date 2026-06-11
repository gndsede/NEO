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
