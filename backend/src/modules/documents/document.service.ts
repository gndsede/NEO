import {
  DocumentStatus,
  DocumentOwnerType,
  RequirementCollectionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getStorage } from "../../lib/storage/index.js";
import { BadRequest, Forbidden, NotFound } from "../../lib/errors.js";
import { recomputeWorkerAccessValidity } from "../workers/worker.access.js";
import type {
  AttachDocumentInput,
  ListDocumentsQuery,
} from "./document.schema.js";

interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

interface ReviewContext {
  /** Usuário que está avaliando (auditoria). */
  reviewerId: string;
  companyId: string;
}

export class DocumentService {
  private async getOwnedDocument(companyId: string, id: string) {
    const doc = await prisma.document.findFirst({
      where: { id, companyId },
    });
    if (!doc) throw NotFound("Documento não encontrado");
    return doc;
  }

  async list(companyId: string, query: ListDocumentsQuery) {
    const where: Prisma.DocumentWhereInput = {
      companyId,
      ...(query.ownerType ? { ownerType: query.ownerType } : {}),
      ...(query.workerId ? { workerId: query.workerId } : {}),
      ...(query.contractorId ? { contractorId: query.contractorId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [total, items] = await Promise.all([
      prisma.document.count({ where }),
      prisma.document.findMany({
        where,
        include: {
          reviewedBy: { select: { id: true, name: true, email: true } },
          uploadedBy: { select: { id: true, name: true, email: true } },
          worker: { select: { id: true, fullName: true } },
          contractor: { select: { id: true, name: true } },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    return {
      items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getById(companyId: string, id: string) {
    const doc = await prisma.document.findFirst({
      where: { id, companyId },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
        uploadedBy: { select: { id: true, name: true, email: true } },
        worker: { select: { id: true, fullName: true } },
        contractor: { select: { id: true, name: true } },
      },
    });
    if (!doc) throw NotFound("Documento não encontrado");
    return doc;
  }

  /**
   * Workflow de aprovação. Registra QUEM aprovou e QUANDO (auditoria).
   * Idempotência defensiva: não permite re-aprovar/re-rejeitar cegamente.
   */
  async approve(
    documentId: string,
    ctx: ReviewContext,
    opts?: { expiresAt?: Date },
  ) {
    const doc = await this.getOwnedDocument(ctx.companyId, documentId);
    if (doc.status === DocumentStatus.APROVADO) {
      throw BadRequest("Documento já está aprovado");
    }
    if (doc.uploadedById && doc.uploadedById === ctx.reviewerId) {
      throw Forbidden(
        "Quem anexou o documento não pode aprová-lo. A avaliação deve ser feita por outro usuário.",
      );
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: DocumentStatus.APROVADO,
        reviewedById: ctx.reviewerId,
        reviewedAt: new Date(),
        rejectionReason: null,
        ...(opts?.expiresAt ? { expiresAt: opts.expiresAt } : {}),
      },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    // Recalcula validade de acesso do colaborador (documentação consolidada).
    if (updated.ownerType === DocumentOwnerType.WORKER && updated.workerId) {
      await recomputeWorkerAccessValidity(updated.workerId);
    }

    if (updated.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: updated.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.APPROVED,
          naReason: null,
          latestDocumentId: updated.id,
        },
      });
    }
    if (updated.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: updated.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.APPROVED,
          naReason: null,
          latestDocumentId: updated.id,
        },
      });
    }

    return updated;
  }

  async reject(documentId: string, ctx: ReviewContext, reason: string) {
    const doc = await this.getOwnedDocument(ctx.companyId, documentId);
    if (doc.status === DocumentStatus.REJEITADO) {
      throw BadRequest("Documento já está rejeitado");
    }
    if (doc.uploadedById && doc.uploadedById === ctx.reviewerId) {
      throw Forbidden(
        "Quem anexou o documento não pode reprová-lo. A avaliação deve ser feita por outro usuário.",
      );
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: DocumentStatus.REJEITADO,
        reviewedById: ctx.reviewerId,
        reviewedAt: new Date(),
        rejectionReason: reason,
      },
      include: {
        reviewedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (updated.ownerType === DocumentOwnerType.WORKER && updated.workerId) {
      await recomputeWorkerAccessValidity(updated.workerId);
    }

    if (updated.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: updated.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.REJECTED,
          latestDocumentId: updated.id,
        },
      });
    }
    if (updated.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: updated.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.REJECTED,
          latestDocumentId: updated.id,
        },
      });
    }

    return updated;
  }

  /** Anexa um documento avulso (a Worker ou Contractor) via upload. */
  async attach(
    companyId: string,
    data: AttachDocumentInput,
    file?: UploadedFile,
    uploadedById?: string,
  ) {
    if (!file) throw BadRequest("Arquivo do documento é obrigatório");

    // Garante que o owner pertence ao tenant.
    if (data.ownerType === DocumentOwnerType.WORKER) {
      const w = await prisma.worker.findFirst({
        where: { id: data.workerId!, companyId },
        select: { id: true },
      });
      if (!w) throw NotFound("Colaborador não encontrado");
      if (data.workerRequirementItemId) {
        const item = await prisma.workerRequirementItem.findFirst({
          where: {
            id: data.workerRequirementItemId,
            companyId,
            workerId: data.workerId!,
          },
          select: { id: true, status: true },
        });
        if (!item) {
          throw NotFound("Exigência do colaborador não encontrada");
        }
      }
    } else {
      const c = await prisma.contractor.findFirst({
        where: { id: data.contractorId!, companyId },
        select: { id: true },
      });
      if (!c) throw NotFound("Empreiteira não encontrada");
      if (data.contractorRequirementItemId) {
        const item = await prisma.contractorRequirementItem.findFirst({
          where: {
            id: data.contractorRequirementItemId,
            companyId,
            contractorId: data.contractorId!,
          },
          select: { id: true, status: true },
        });
        if (!item) {
          throw NotFound("Exigência do fornecedor não encontrada");
        }
      }
    }

    const storage = await getStorage();
    const stored = await storage.upload({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      folder: `companies/${companyId}/documents`,
    });

    const created = await prisma.document.create({
      data: {
        companyId,
        ownerType: data.ownerType,
        workerId: data.ownerType === "WORKER" ? data.workerId : null,
        contractorId:
          data.ownerType === "CONTRACTOR" ? data.contractorId : null,
        workerRequirementItemId:
          data.ownerType === "WORKER" ? data.workerRequirementItemId : null,
        contractorRequirementItemId:
          data.ownerType === "CONTRACTOR"
            ? data.contractorRequirementItemId
            : null,
        type: data.type,
        title: data.title,
        fileUrl: stored.url,
        fileKey: stored.key,
        mimeType: file.mimetype,
        fileSize: file.size,
        issuedAt: data.issuedAt,
        expiresAt: data.expiresAt,
        uploadedById,
      },
    });

    if (created.workerRequirementItemId) {
      await prisma.workerRequirementItem.update({
        where: { id: created.workerRequirementItemId },
        data: {
          status: RequirementCollectionStatus.PENDING_APPROVAL,
          naReason: null,
          latestDocumentId: created.id,
        },
      });
    }
    if (created.contractorRequirementItemId) {
      await prisma.contractorRequirementItem.update({
        where: { id: created.contractorRequirementItemId },
        data: {
          status: RequirementCollectionStatus.PENDING_APPROVAL,
          naReason: null,
          latestDocumentId: created.id,
        },
      });
    }

    return created;
  }
}

export const documentService = new DocumentService();
