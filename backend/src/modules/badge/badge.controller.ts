import type { Request, Response } from "express";
import { badgeService } from "./badge.service.js";
import { Unauthorized } from "../../lib/errors.js";

export const badgeController = {
  /**
   * GET /workers/:id/badge
   * Retorna o payload do crachá (JSON), incluindo o QR Code em base64.
   * O frontend pode renderizar e exportar como PDF (html2canvas + jsPDF),
   * ou outra rota/serviço pode transformá-lo em PDF no backend.
   */
  async generate(req: Request, res: Response) {
    if (!req.user) throw Unauthorized();
    const payload = await badgeService.generate(req.user, String(req.params.id));
    res.json(payload);
  },

  /**
   * GET /workers/:id/badge/qrcode.png
   * Atalho que devolve apenas a imagem do QR Code (binário PNG),
   * útil para <img src> direto ou impressão.
   */
  async qrcodePng(req: Request, res: Response) {
    if (!req.user) throw Unauthorized();
    const payload = await badgeService.generate(req.user, String(req.params.id));
    const base64 = payload.access.qrCodeDataUrl.replace(
      /^data:image\/png;base64,/,
      "",
    );
    const buffer = Buffer.from(base64, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  },
};
