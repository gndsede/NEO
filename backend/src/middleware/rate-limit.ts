import rateLimit from "express-rate-limit";

/**
 * NOTA DE ESCALA (auditoria F12 — CWE-307): todos os limiters abaixo usam o
 * store em memória, adequado APENAS para deploy de instância única (situação
 * atual no Railway). Antes de escalar horizontalmente, migre para um store
 * compartilhado — ex.: `rate-limit-redis` com `new RedisStore({ client })`
 * passado na opção `store` de cada limiter — ou os contadores deixam de ser
 * globais e a proteção contra força bruta se dilui entre instâncias.
 */

/**
 * Limita tentativas de login por IP. Conta apenas tentativas que falham
 * (`skipSuccessfulRequests`), para não travar um usuário legítimo que erra
 * a senha uma vez e depois acerta.
 */
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Muitas tentativas de login. Tente novamente em alguns minutos." },
});

/**
 * Rate limit global da API — proteção contra abuso/DoS simples.
 * Generoso o bastante para uso normal do painel (dashboards fazem várias
 * chamadas em paralelo), mas barra scraping e brute-force distribuído básico.
 */
export const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas requisições. Aguarde um instante e tente novamente." },
});

/**
 * Rate limit dedicado das operações de 2FA (enable/disable/backup codes).
 * Sem ele, só o limite genérico da API (300/min) protegeria a força bruta
 * de códigos TOTP de 6 dígitos (auditoria F13 — CWE-307, OWASP API2:2023).
 */
export const twoFactorRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "Muitas tentativas de código 2FA. Tente novamente em alguns minutos." },
});

/**
 * Rate limit dos endpoints públicos (validação de token QR).
 * Bem mais restrito: inviabiliza enumeração de tokens por força bruta.
 */
export const publicRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas consultas. Aguarde um instante e tente novamente." },
});
