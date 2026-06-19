import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { upload, workerUpload } from "../../middleware/upload.js";
import { workerController } from "./worker.controller.js";
import { badgeRoutes } from "../badge/badge.routes.js";

const router = Router();

router.use(authenticate);

// Geração de crachá (QR Code + estrutura para PDF) por colaborador.
router.use("/:id/badge", badgeRoutes);

/**
 * Cadastro completo de colaborador (multipart/form-data).
 * Campos texto + `photo` (1 arquivo) + `documents` (N arquivos) +
 * `documentsMeta` (JSON string com metadados alinhados aos documentos).
 */
router.post(
  "/",
  requireCapability("colaboradores.manage"),
  workerUpload,
  asyncHandler(workerController.create),
);

router.post(
  "/import",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.importBatch),
);

router.get("/", asyncHandler(workerController.list));
// Rotas literais precisam vir antes de "/:id" para não serem capturadas como id.
router.get(
  "/requirements",
  asyncHandler(workerController.listAllRequirements),
);
router.get(
  "/requirements-summary",
  asyncHandler(workerController.requirementsSummary),
);
router.get(
  "/:id/access-token",
  asyncHandler(workerController.getAccessToken),
);
router.get("/:id", asyncHandler(workerController.getById));

router.patch(
  "/:id",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.update),
);

router.patch(
  "/:id/photo",
  requireCapability("colaboradores.manage"),
  upload.single("photo"),
  asyncHandler(workerController.updatePhoto),
);

router.get(
  "/:id/requirements",
  asyncHandler(workerController.listRequirements),
);

router.post(
  "/:id/requirements/manual",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.addManualRequirement),
);

router.patch(
  "/:id/requirements/:itemId/applicability",
  requireCapability("documentos.mark_na"),
  asyncHandler(workerController.setRequirementApplicability),
);

export const workerRoutes = router;
