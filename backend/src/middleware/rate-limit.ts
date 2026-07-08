import rateLimit from "express-rate-limit";

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
