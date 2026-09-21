import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LifecyclePhase } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { workerService } from "../src/modules/workers/worker.service.js";
import type { AuthScope } from "../src/lib/scope.js";

/**
 * Ciclo documental do vínculo: ENTRADA → ATIVIDADE → SAIDA → inativação.
 *
 * As travas verificadas aqui são as regras do processo: ninguém entra em
 * atividade com documentação admissional pendente e ninguém é inativado sem
 * antes passar pelo processo demissional com a documentação de saída resolvida.
 */

const MARK = `lifecycle-test-${Date.now()}`;

let companyId: string;
let obraId: string;
let contractorId: string;
let scope: AuthScope;

/** Função com exigências de entrada, atividade e saída. */
let functionCompletoId: string;
/** Função sem nenhuma exigência de entrada. */
let functionSemEntradaId: string;

async function createDefinition(name: string, phases: LifecyclePhase[]) {
  return prisma.documentRequirementDefinition.create({
    data: {
      companyId,
      target: "WORKER",
      name: `${MARK}-${name}`,
      documentType: "STANDARD",
      frequency: "ONE_TIME",
      phases,
    },
  });
}

async function createWorker(suffix: string) {
  return prisma.worker.create({
    data: {
      companyId,
      fullName: `${MARK}-worker-${suffix}`,
      cpf: `${MARK}-cpf-${suffix}`,
      cpfHash: `${MARK}-cpf-hash-${suffix}`,
      qrHash: `${MARK}-qr-${suffix}`,
    },
  });
}

/** Itens de exigência de um vínculo, agrupados por fase. */
async function itemsByPhase(assignmentId: string) {
  const items = await prisma.workerRequirementItem.findMany({
    where: { assignmentId },
    select: { id: true, name: true, phase: true, status: true },
  });
  return {
    ENTRADA: items.filter((i) => i.phase === "ENTRADA"),
    ATIVIDADE: items.filter((i) => i.phase === "ATIVIDADE"),
    SAIDA: items.filter((i) => i.phase === "SAIDA"),
  };
}

beforeAll(async () => {
  const company = await prisma.company.create({ data: { name: `${MARK}-company` } });
  companyId = company.id;

  const obra = await prisma.obra.create({ data: { companyId, name: `${MARK}-obra` } });
  obraId = obra.id;

  const contractor = await prisma.contractor.create({
    data: { companyId, obraId, name: `${MARK}-contractor` },
  });
  contractorId = contractor.id;

  const [entrada, atividade, saida, ambas] = await Promise.all([
    createDefinition("exame-admissional", [LifecyclePhase.ENTRADA]),
    createDefinition("aso-periodico", [LifecyclePhase.ATIVIDADE]),
    createDefinition("termo-rescisao", [LifecyclePhase.SAIDA]),
    createDefinition("termo-epi", [LifecyclePhase.ENTRADA, LifecyclePhase.ATIVIDADE]),
  ]);

  const fnCompleto = await prisma.workerFunction.create({
    data: {
      companyId,
      name: `${MARK}-pedreiro`,
      requirements: {
        create: [entrada, atividade, saida, ambas].map((d) => ({
          requirementId: d.id,
          required: true,
        })),
      },
    },
  });
  functionCompletoId = fnCompleto.id;

  const fnSemEntrada = await prisma.workerFunction.create({
    data: {
      companyId,
      name: `${MARK}-vigia`,
      requirements: { create: [{ requirementId: atividade.id, required: true }] },
    },
  });
  functionSemEntradaId = fnSemEntrada.id;

  scope = {
    id: `${MARK}-user`,
    companyId,
    profile: "USER",
    email: `${MARK}@example.com`,
    permissions: ["colaboradores.manage", "documentos.mark_na"],
    contractorId: null,
    obraIds: [obraId],
    activeObraId: obraId,
    allObrasAccess: false,
    allowedDocumentTypes: null,
  };
});

afterAll(async () => {
  await prisma.workerRequirementItem.deleteMany({ where: { companyId } });
  await prisma.workerAssignment.deleteMany({ where: { companyId } });
  await prisma.worker.deleteMany({ where: { companyId } });
  await prisma.workerFunctionRequirement.deleteMany({
    where: { function: { companyId } },
  });
  await prisma.workerFunction.deleteMany({ where: { companyId } });
  await prisma.documentRequirementDefinition.deleteMany({ where: { companyId } });
  await prisma.contractor.deleteMany({ where: { companyId } });
  await prisma.obra.deleteMany({ where: { companyId } });
  await prisma.company.delete({ where: { id: companyId } });
});

describe("ciclo documental do vínculo (entrada → atividade → saída)", () => {
  it("vínculo novo nasce em ENTRADA com as cobranças de entrada e de atividade", async () => {
    const worker = await createWorker("a");
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      functionId: functionCompletoId,
      role: "Pedreiro",
    } as never);

    expect(assignment.phase).toBe(LifecyclePhase.ENTRADA);

    const items = await itemsByPhase(assignment.id);
    // exame admissional + termo de EPI
    expect(items.ENTRADA).toHaveLength(2);
    // ASO periódico + termo de EPI (o mesmo registro em duas fases vira 2 itens)
    expect(items.ATIVIDADE).toHaveLength(2);
    // documentação de saída só nasce no processo demissional
    expect(items.SAIDA).toHaveLength(0);
  });

  it("não libera para atividade com documentação de entrada pendente", async () => {
    const worker = await createWorker("b");
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      functionId: functionCompletoId,
      role: "Pedreiro",
    } as never);

    await expect(
      workerService.changePhase(
        scope,
        worker.id,
        assignment.id,
        LifecyclePhase.ATIVIDADE,
      ),
    ).rejects.toThrow(/documentos de documentação de entrada/i);

    const status = await workerService.getPhaseStatus(scope, worker.id, assignment.id);
    expect(status.phase).toBe(LifecyclePhase.ENTRADA);
    expect(status.canActivate).toBe(false);
    expect(status.gates.ENTRADA.pending).toHaveLength(2);
  });

  it("resolver a última pendência de entrada promove o vínculo sozinho", async () => {
    const worker = await createWorker("c");
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      functionId: functionCompletoId,
      role: "Pedreiro",
    } as never);

    const items = await itemsByPhase(assignment.id);
    for (const item of items.ENTRADA) {
      await workerService.setRequirementApplicability(scope, worker.id, item.id, {
        status: "NOT_APPLICABLE",
        naReason: "Dispensado no teste",
      });
    }

    const status = await workerService.getPhaseStatus(scope, worker.id, assignment.id);
    expect(status.phase).toBe(LifecyclePhase.ATIVIDADE);
  });

  it("sem exigência de entrada cadastrada, o vínculo já nasce em atividade", async () => {
    const worker = await createWorker("d");
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      functionId: functionSemEntradaId,
      role: "Vigia",
    } as never);

    expect(assignment.phase).toBe(LifecyclePhase.ATIVIDADE);
  });

  it("função atribuída depois do cadastro devolve o vínculo para a fase de entrada", async () => {
    const worker = await createWorker("f");
    // Cadastro sem função: nada a cobrar, entra direto em atividade.
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      role: "Ajudante",
    } as never);
    expect(assignment.phase).toBe(LifecyclePhase.ATIVIDADE);

    // Ao receber a primeira função, a documentação admissional passa a existir.
    await workerService.updateAssignment(scope, worker.id, assignment.id, {
      functionId: functionCompletoId,
    } as never);

    const status = await workerService.getPhaseStatus(scope, worker.id, assignment.id);
    expect(status.phase).toBe(LifecyclePhase.ENTRADA);
    expect(status.gates.ENTRADA.pending.length).toBeGreaterThan(0);
  });

  it("inativar exige processo demissional com documentação de saída resolvida", async () => {
    const worker = await createWorker("e");
    const assignment = await workerService.addAssignment(scope, worker.id, {
      contractorId,
      functionId: functionSemEntradaId,
      role: "Vigia",
    } as never);

    // 1. Em atividade, inativar direto é recusado.
    await expect(
      workerService.updateAssignment(scope, worker.id, assignment.id, {
        status: "INACTIVE",
      } as never),
    ).rejects.toThrow(/processo demissional/i);

    // 2. Abrir o desligamento materializa a documentação de saída.
    await prisma.workerFunctionRequirement.create({
      data: {
        functionId: functionSemEntradaId,
        requirementId: (
          await createDefinition("rescisao-vigia", [LifecyclePhase.SAIDA])
        ).id,
        required: true,
      },
    });
    await workerService.changePhase(
      scope,
      worker.id,
      assignment.id,
      LifecyclePhase.SAIDA,
    );

    const items = await itemsByPhase(assignment.id);
    expect(items.SAIDA).toHaveLength(1);

    // 3. Com a saída pendente, ainda não inativa.
    await expect(
      workerService.updateAssignment(scope, worker.id, assignment.id, {
        status: "INACTIVE",
      } as never),
    ).rejects.toThrow(/documentos de documentação de saída/i);

    // 4. Resolvida a documentação de saída, a inativação passa.
    await workerService.setRequirementApplicability(
      scope,
      worker.id,
      items.SAIDA[0]!.id,
      { status: "NOT_APPLICABLE", naReason: "Dispensado no teste" },
    );
    const updated = await workerService.updateAssignment(
      scope,
      worker.id,
      assignment.id,
      { status: "INACTIVE" } as never,
    );
    expect(updated.status).toBe("INACTIVE");
  });
});
