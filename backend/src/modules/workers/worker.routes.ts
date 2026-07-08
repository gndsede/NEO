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

// Leituras expõem PII — exigem permissão de colaboradores ou de documentação.
const canViewWorkers = requireCapability(
  "colaboradores.view",
  "colaboradores.manage",
  "documentos.view",
  "documentos.attach",
  "documentos.approve",
);

router.get("/", canViewWorkers, asyncHandler(workerController.list));
// Rotas literais precisam vir antes de "/:id" para não serem capturadas como id.
router.get(
  "/requirements",
  canViewWorkers,
  asyncHandler(workerController.listAllRequirements),
);
router.get(
  "/requirements-summary",
  canViewWorkers,
  asyncHandler(workerController.requirementsSummary),
);
router.get(
  "/:id/access-token",
  requireCapability(
    "cracha.view",
    "cracha.generate",
    "colaboradores.view",
    "colaboradores.manage",
    "catraca.view",
    "catraca.manage",
  ),
  asyncHandler(workerController.getAccessToken),
);
router.get("/:id", canViewWorkers, asyncHandler(workerController.getById));

router.patch(
  "/:id",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.update),
);

router.post(
  "/:id/assignments",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.addAssignment),
);

router.patch(
  "/:id/assignments/:assignmentId",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.updateAssignment),
);

router.patch(
  "/:id/photo",
  requireCapability("colaboradores.manage"),
  upload.single("photo"),
  asyncHandler(workerController.updatePhoto),
);

router.get(
  "/:id/requirements",
  canViewWorkers,
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

/**
 * POST /workers/:id/anonymize
 * Anonimização irreversível de dados pessoais (LGPD Direito ao Apagamento).
 * Requer body: { confirm: true }
 */
router.post(
  "/:id/anonymize",
  requireCapability("colaboradores.manage"),
  asyncHandler(workerController.anonymize),
);

export const workerRoutes = router;
