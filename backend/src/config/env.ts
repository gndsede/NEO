import "dotenv/config";
import { z } from "zod";

/**
 * Origens de produção conhecidas do frontend. Usadas como fallback seguro
 * quando `CORS_ORIGIN` não é configurado explicitamente em produção — evita
 * tanto o wildcard inseguro quanto um crash de boot por variável ausente.
 * Domínios customizados adicionais devem ser informados via `CORS_ORIGIN`.
 */
const KNOWN_PRODUCTION_ORIGINS = [
  "https://neo-solucoes-civis.vercel.app",
];

/**
 * Validação centralizada das variáveis de ambiente.
 * Falha rápido (fail-fast) no boot se algo essencial estiver ausente/ inválido.
 * Em produção, aplica defaults SEGUROS (não inseguros) para variáveis de
 * borda ausentes, de modo que o deploy suba pronto para uso sem abrir brechas.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3333),
  // Em produção, "*" (ou ausente) é substituído pelas origens de produção
  // conhecidas (ver transform abaixo) — nunca refletimos qualquer origem com
  // credentials, mas também não derrubamos o boot por variável não configurada.
  CORS_ORIGIN: z.string().default("*"),

  // URL pública do frontend (Vercel) — usada para montar links de e-mail
  // (ex.: convite de definição de senha do administrador do tenant).
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // Número de proxies confiáveis à frente da API (nginx/ELB = 1).
  // Necessário para o rate limit identificar o IP real do cliente.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().url(),

  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET deve ter ao menos 32 caracteres (ex.: openssl rand -hex 32)"),
  // Sessões do app da catraca (opera offline por longos períodos).
  JWT_EXPIRES_IN: z.string().default("7d"),
  // Sessões do painel web — mais curtas: o token vive em localStorage e um
  // XSS teria acesso direto a ele (ver auditoria F08). 12h cobre a jornada
  // de trabalho sem estender a janela de reuso de um token vazado.
  JWT_EXPIRES_IN_WEB: z.string().default("12h"),

  BADGE_HASH_SECRET: z
    .string()
    .min(32, "BADGE_HASH_SECRET deve ter ao menos 32 caracteres (ex.: openssl rand -hex 32)"),
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
}).transform((cfg) => {
  if (cfg.NODE_ENV !== "production") return cfg;

  const next = { ...cfg };

  // OWASP A05:2021 / ISO 27001 A.8.9 — configuração segura por padrão.
  // Wildcard + credentials expõe a API a qualquer origem: em produção,
  // substituímos "*"/vazio pelas origens de produção conhecidas.
  if (next.CORS_ORIGIN === "*" || next.CORS_ORIGIN.trim() === "") {
    next.CORS_ORIGIN = KNOWN_PRODUCTION_ORIGINS.join(",");
    // eslint-disable-next-line no-console
    console.warn(
      `⚠️  CORS_ORIGIN não configurado em produção — usando origem padrão: ${next.CORS_ORIGIN}. ` +
        "Defina CORS_ORIGIN no ambiente para incluir domínios customizados.",
    );
  }

  // Atrás do load balancer (Railway) sem TRUST_PROXY, o rate limit enxerga um
  // único IP (o do proxy) e a proteção contra força bruta é neutralizada.
  // Railway/PaaS estão sempre atrás de proxy: default seguro = 1.
  if (process.env.TRUST_PROXY === undefined) {
    next.TRUST_PROXY = 1;
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  TRUST_PROXY não definido em produção — assumindo 1 (API atrás de proxy). " +
        "Defina TRUST_PROXY=0 explicitamente se a API estiver exposta diretamente.",
    );
  }

  // Segredo do crachá com valor de exemplo é fraco, mas não deve derrubar o
  // boot de um sistema em uso — apenas alerta para rotação.
  if (/troque|change|example|placeholder/i.test(next.BADGE_HASH_SECRET)) {
    // eslint-disable-next-line no-console
    console.warn(
      "⚠️  BADGE_HASH_SECRET parece um valor de exemplo. Gere um segredo forte: openssl rand -hex 32",
    );
  }

  return next;
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
