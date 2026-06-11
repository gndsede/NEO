import { Router } from "express";
import { asyncHandler } from "../../middleware/async-handler.js";
import { authenticate, requireCapability } from "../../middleware/auth.js";
import { requirementsController } from "./requirements.controller.js";

const router = Router();
router.use(authenticate);

router.get(
  "/definitions",
  asyncHandler(requirementsController.listDefinitions),
);
router.post(
  "/definitions",
  requireCapability("registros.manage"),
  asyncHandler(requirementsController.createDefinition),
);
router.patch(
  "/definitions/:id",
  requireCapability("registros.manage"),
  asyncHandler(requirementsController.updateDefinition),
);

router.get(
  "/worker-functions",
  asyncHandler(requirementsController.listWorkerFunctions),
);
router.post(
  "/worker-functions",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.createWorkerFunction),
);
router.patch(
  "/worker-functions/:id",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.updateWorkerFunction),
);
router.post(
  "/worker-functions/copy-requirements",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.copyWorkerFunctionRequirements),
);

router.get(
  "/contractor-types",
  asyncHandler(requirementsController.listContractorTypes),
);
router.post(
  "/contractor-types",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.createContractorType),
);
router.patch(
  "/contractor-types/:id",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.updateContractorType),
);
router.post(
  "/contractor-types/copy-requirements",
  requireCapability("tipos.manage"),
  asyncHandler(requirementsController.copyContractorTypeRequirements),
);

export const requirementsRoutes = router;
