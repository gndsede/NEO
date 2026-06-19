import { Router } from "express";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { contractorRoutes } from "./modules/contractors/contractor.routes.js";
import { workerRoutes } from "./modules/workers/worker.routes.js";
import { documentRoutes } from "./modules/documents/document.routes.js";
import { accessRoutes } from "./modules/access/access.routes.js";
import { requirementsRoutes } from "./modules/requirements/requirements.routes.js";
import { reportRoutes } from "./modules/reports/report.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { crachasRoutes } from "./modules/crachas/crachas.routes.js";
import { obrasRoutes } from "./modules/obras/obras.routes.js";
import { publicRoutes } from "./modules/public/public.routes.js";
import { syncRoutes } from "./modules/sync/sync.routes.js";
import { rdoRoutes } from "./modules/rdo/rdo.routes.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "accesshub-api", ts: new Date().toISOString() });
});

apiRouter.use("/public", publicRoutes);
apiRouter.use("/auth", authRoutes);
apiRouter.use("/contractors", contractorRoutes);
apiRouter.use("/workers", workerRoutes); // inclui /workers/:id/badge
apiRouter.use("/documents", documentRoutes);
apiRouter.use("/access", accessRoutes);
apiRouter.use("/requirements", requirementsRoutes);
apiRouter.use("/reports", reportRoutes);
apiRouter.use("/users", usersRoutes);
apiRouter.use("/obras", obrasRoutes);
apiRouter.use("/crachas", crachasRoutes);
apiRouter.use("/sync", syncRoutes);
apiRouter.use("/rdo", rdoRoutes);
