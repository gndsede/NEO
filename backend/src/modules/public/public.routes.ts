import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { publicRateLimit } from "../../middleware/rate-limit.js";
import {
  isValidNeoAccessToken,
  NEO_QR_SPEC,
  resolveScannedToken,
} from "../../utils/access-hash.js";

const router = Router();

// Endpoints públicos são o alvo natural de enumeração — limite agressivo por IP.
router.use(publicRateLimit);

/** Especificação do formato de token/QR para integração de TI externa. */
router.get(
  "/qr-spec",
  (_req, res) => {
    res.json({
      spec: NEO_QR_SPEC,
      qrPayload:
        "O conteúdo do QR Code deve ser o payload assinado fornecido pela plataforma (campo qrPayload do colaborador, ex.: NEO-3K7BM2-1A2B3C4D).",
      integration: {
        encode:
          "Gere o QR Code com o valor literal do campo qrPayload do colaborador (token + assinatura HMAC). Não construa o payload manualmente.",
        scan: "A catraca aceita o payload lido diretamente ou via URL com parâmetro ?t=PAYLOAD.",
      },
    });
  },
);

/**
 * Validação pública de payload de QR — permite que TI de empreiteiras confira
 * se um QR gerado está bem formado e com assinatura íntegra.
 *
 * Endurecido (auditoria F15/F02 — OWASP API3:2023/API9:2023):
 *  - NENHUMA consulta ao banco: este endpoint não confirma existência de
 *    colaborador nem revela obra/empresa — apenas valida formato e assinatura.
 *  - Sem assinatura válida, um token "de formato correto" não é confirmado,
 *    eliminando o oráculo que ajudava a clonar crachás por enumeração.
 */
router.get(
  "/access-tokens/:token",
  asyncHandler(async (req, res) => {
    const raw = String(req.params.token);
    const resolved = resolveScannedToken(raw);

    // Payload assinado com HMAC íntegro — único caso confirmado como válido.
    if (resolved.token && resolved.signed) {
      res.json({ valid: true, signed: true, spec: NEO_QR_SPEC });
      return;
    }

    // Token legado sem assinatura: informa apenas validade de FORMATO,
    // sem consultar o banco (não confirma se o token existe).
    if (resolved.token || isValidNeoAccessToken(raw)) {
      res.json({
        valid: false,
        signed: false,
        formatValid: true,
        spec: NEO_QR_SPEC,
        error:
          "Payload sem assinatura. Use o campo qrPayload fornecido pela plataforma (token + assinatura HMAC).",
      });
      return;
    }

    res.status(400).json({
      valid: false,
      signed: false,
      formatValid: false,
      spec: NEO_QR_SPEC,
      error: "Formato inválido. Use o payload assinado fornecido pela plataforma.",
    });
  }),
);

export const publicRoutes = router;
