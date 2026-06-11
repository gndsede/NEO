import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/async-handler.js";
import {
  isValidNeoAccessToken,
  NEO_QR_SPEC,
  normalizeScannedQr,
} from "../../utils/access-hash.js";

const router = Router();

/** Especificação do formato de token/QR para integração de TI externa. */
router.get(
  "/qr-spec",
  (_req, res) => {
    res.json({
      spec: NEO_QR_SPEC,
      qrPayload: "O conteúdo do QR Code deve ser exatamente o token (ex.: NEO-3K7BM2).",
      integration: {
        encode: "Gere o QR Code com o valor literal do campo accessToken do colaborador.",
        scan: "A catraca aceita o token lido diretamente ou via URL com parâmetro ?t=TOKEN.",
      },
    });
  },
);

/**
 * Consulta pública de token — permite que TI de empreiteiras valide o formato
 * e obtenha o payload exato para gerar QR Codes próprios.
 */
router.get(
  "/access-tokens/:token",
  asyncHandler(async (req, res) => {
    const token = normalizeScannedQr(String(req.params.token));

    if (!isValidNeoAccessToken(token)) {
      res.status(400).json({
        valid: false,
        token,
        qrPayload: null,
        spec: NEO_QR_SPEC,
        error: "Formato inválido. Use o padrão NEO-0A0AA0 (0=dígito, A=letra).",
      });
      return;
    }

    const worker = await prisma.worker.findUnique({
      where: { qrHash: token },
      select: {
        id: true,
        fullName: true,
        status: true,
        registration: true,
        company: { select: { name: true, siteName: true } },
        contractor: { select: { name: true } },
      },
    });

    res.json({
      valid: !!worker,
      token,
      qrPayload: token,
      spec: NEO_QR_SPEC,
      worker: worker
        ? {
            id: worker.id,
            fullName: worker.fullName,
            status: worker.status,
            registration: worker.registration,
            company: worker.company.siteName ?? worker.company.name,
            contractor: worker.contractor.name,
          }
        : null,
    });
  }),
);

export const publicRoutes = router;
