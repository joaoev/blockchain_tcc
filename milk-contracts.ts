import { Context, Contract, Info, Returns, Transaction } from "fabric-contract-api";
import { MilkBatch, TransportEvent, LabResults, ProcessingType } from "./src/types";

/** Helpers bem simples */

function txTimeISO(ctx: Context): string {
  const ts = ctx.stub.getTxTimestamp(); // { seconds, nanos }
  const ms = Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6);
  return new Date(ms).toISOString();
}

const nowISO = () => new Date().toISOString();
const keyOf = (batchId: string) => `MILK#${batchId}`;

function requireFields(obj: any, fields: string[]) {
  for (const f of fields) if (obj[f] === undefined || obj[f] === null) {
    throw new Error(`Campo obrigatório ausente: ${f}`);
  }
}

function getMSP(ctx: Context) {
  // MSP do emissor da transação, para “papéis” simples
  // ex: FARMMSP, LABMSP, DAIRYMSP, RETAILMSP, DISTMSP
 
  return ctx.clientIdentity.getMSPID?.() || "UNKNOWNMSP";
}

async function getBatch(ctx: Context, batchId: string): Promise<MilkBatch> {
  const data = await ctx.stub.getState(keyOf(batchId));
  if (!data || data.length === 0) throw new Error(`Lote não encontrado: ${batchId}`);
  return JSON.parse(data.toString());
}

async function putBatch(ctx: Context, batch: MilkBatch) {
  await ctx.stub.putState(keyOf(batch.batchId), Buffer.from(JSON.stringify(batch)));
}

/** Regras de "papéis" (bem simples — mapeie seus MSP IDs) */
const RoleMap: Record<string, "FARM" | "LAB" | "DAIRY" | "DIST" | "RETAIL" | "UNKNOWN"> = {
  Org1MSP: "FARM",   // mapeie como quiser: FARM para criar lote
  Org2MSP: "DAIRY"   // e.g., DAIRY para aprovar/processar
};

const Roles = {
  isFarm(msp: string) { return RoleMap[msp] === "FARM"; },
  isLab(msp: string) { return RoleMap[msp] === "LAB"; },
  isDairy(msp: string) { return RoleMap[msp] === "DAIRY"; },
  isDistribution(msp: string) { return RoleMap[msp] === "DIST"; },
  isRetail(msp: string) { return RoleMap[msp] === "RETAIL"; },
};

@Info({ title: "MilkContract", description: "Blockchain da cadeia do leite (anti-fraude, simples)" })
export class MilkContract extends Contract {

  // ---------- CRUD & CONSULTAS ----------

  @Transaction(false)
  @Returns("string")
  async ReadBatch(ctx: Context, batchId: string): Promise<string> {
    const batch = await getBatch(ctx, batchId);
    return JSON.stringify(batch);
  }

  @Transaction(false)
  @Returns("string")
  async GetHistory(ctx: Context, batchId: string): Promise<string> {
    const iterator = await ctx.stub.getHistoryForKey(keyOf(batchId));
    const history: any[] = [];
    for await (const res of iterator as any) {
      history.push({
        txId: res.txId,
        timestamp: res.timestamp?.seconds?.low
          ? new Date(res.timestamp.seconds.low * 1000).toISOString()
          : undefined,
        isDelete: res.isDelete,
        value: res.value?.toString() || ""
      });
    }
    return JSON.stringify(history);
  }


@Transaction(false)
@Returns("string")
async GetAllBatches(ctx: Context): Promise<string> {
  const iterator = await ctx.stub.getStateByRange("MILK#", "MILK#\uffff");
  const batches: MilkBatch[] = [];
  
  let result = await iterator.next();
  while (!result.done) {
    const value = result.value?.value?.toString();
    if (value) {
      batches.push(JSON.parse(value));
    }
    result = await iterator.next();
  }
  
  await iterator.close();
  return JSON.stringify(batches);
}

  // ---------- FLUXO: FAZENDA ----------

  /** Cria um lote na fazenda */
  @Transaction()
  async CreateBatch(ctx: Context, batchId: string, producerId: string, volumeLitersStr: string, farmTempCStr?: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!Roles.isFarm(msp)) throw new Error("Apenas FARM MSP pode criar lote");
    const exists = await ctx.stub.getState(keyOf(batchId));
    if (exists && exists.length) throw new Error(`Lote ${batchId} já existe`);

    const volumeLiters = Number(volumeLitersStr);
    const farmTemp = farmTempCStr !== undefined ? Number(farmTempCStr) : undefined;
    if (Number.isNaN(volumeLiters) || volumeLiters <= 0) throw new Error("volumeLiters inválido");

    const batch: MilkBatch = {
      docType: "milkBatch",
      batchId,
      producerId,
      createdAt: txTimeISO(ctx),
      volumeLiters,
      lastFarmTempC: farmTemp,
      transports: [],
      labResults: [],
      currentLocation: `FARM:${producerId}`,
      lockedFields: []
    };
    await putBatch(ctx, batch);
  }

  // ---------- FLUXO: TRANSPORTE ----------

  /** Evento de captação/transporte (Fazenda -> Laticínio/Cooperativa ou entre nós logísticos) */
  @Transaction()
  async AddTransportEvent(ctx: Context, batchId: string, from: string, to: string, temperatureC?: string, volumeLiters?: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!(Roles.isFarm(msp) || Roles.isDistribution(msp) || Roles.isDairy(msp))) {
      throw new Error("Apenas FARM/DIST/DAIRY podem registrar transporte");
    }
    const batch = await getBatch(ctx, batchId);

    const ev: TransportEvent = {
      from, to,
      temperatureC: temperatureC !== undefined ? Number(temperatureC) : undefined,
      volumeLiters: volumeLiters !== undefined ? Number(volumeLiters) : undefined,
      timestamp: txTimeISO(ctx),
      actorMSP: msp
    };
    batch.transports.push(ev);
    batch.currentLocation = to;
    await putBatch(ctx, batch);
  }

  // ---------- FLUXO: LABORATÓRIO ----------

  /** Resultados laboratoriais básicos (anti-fraude e sanidade) */
  @Transaction()
  async AddLabResult(ctx: Context, batchId: string, jsonPayload: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!Roles.isLab(msp)) throw new Error("Apenas LAB MSP pode registrar resultados");

    const payload = JSON.parse(jsonPayload) as Partial<LabResults>;

    if (!payload) throw new Error("Payload inválido");
    const batch = await getBatch(ctx, batchId);

    const result: LabResults = {
      cbt: toNumOrUndef(payload.cbt),
      ccs: toNumOrUndef(payload.ccs),
      acidity: toNumOrUndef(payload.acidity),
      density: toNumOrUndef(payload.density),
      antibiotics: payload.antibiotics === true,
      fraudFlags: Array.isArray(payload.fraudFlags) ? payload.fraudFlags : [],
      timestamp: txTimeISO(ctx),
      actorMSP: msp
    };


    if (result.antibiotics || (result.fraudFlags && result.fraudFlags.length > 0)) {
      batch.approved = false;
      lock(batch, ["volumeLiters"]);
    }

    batch.labResults.push(result);
    await putBatch(ctx, batch);
  }

  @Transaction()
  async ApproveBatch(ctx: Context, batchId: string, approvedStr: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!Roles.isDairy(msp)) throw new Error("Apenas DAIRY MSP pode aprovar lote");

    const approved = /^(true|1|yes)$/i.test(approvedStr);
    const batch = await getBatch(ctx, batchId);

    
    if (batch.approved === false && approved) {
      throw new Error("Lote já reprovado por LAB; não pode aprovar");
    }

    batch.approved = approved;
    if (approved) lock(batch, ["producerId", "createdAt", "volumeLiters"]);
    await putBatch(ctx, batch);
  }


  @Transaction()
  async ProcessBatch(ctx: Context, batchId: string, processingType: ProcessingType, expiresAtISO: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!Roles.isDairy(msp)) throw new Error("Apenas DAIRY MSP pode processar");

    const batch = await getBatch(ctx, batchId);
    if (batch.approved !== true) throw new Error("Lote não aprovado para processamento");

    if (processingType !== "UHT" && processingType !== "PASTEURIZED") {
      throw new Error("processingType inválido (use UHT ou PASTEURIZED)");
    }

    batch.processing = processingType;
    batch.processedAt = txTimeISO(ctx);
    batch.expiresAt = expiresAtISO;
    await putBatch(ctx, batch);
  }

  // ---------- FLUXO: DISTRIBUIÇÃO & VAREJO ----------

  @Transaction()
  async ShipToRetail(ctx: Context, batchId: string, retailerId: string, temperatureC?: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!(Roles.isDairy(msp) || Roles.isDistribution(msp))) {
      throw new Error("Apenas DAIRY/DIST MSP podem expedir ao varejo");
    }
    const batch = await getBatch(ctx, batchId);
    requireProcessed(batch);

    const ev: TransportEvent = {
      from: batch.currentLocation,
      to: `RETAIL:${retailerId}`,
      temperatureC: temperatureC !== undefined ? Number(temperatureC) : undefined,
      timestamp: txTimeISO(ctx),
      actorMSP: msp
    };
    batch.transports.push(ev);
    batch.currentLocation = ev.to;
    await putBatch(ctx, batch);
  }

  @Transaction()
  async ReceiveAtRetail(ctx: Context, batchId: string): Promise<void> {
    const msp = getMSP(ctx);
    if (!Roles.isRetail(msp)) throw new Error("Apenas RETAIL MSP pode receber no varejo");

    const batch = await getBatch(ctx, batchId);
    if (!batch.currentLocation.startsWith("RETAIL:")) {
      throw new Error("Lote não está destinado ao varejo");
    }
    batch.retailReceivedAt = txTimeISO(ctx);
    await putBatch(ctx, batch);
  }
}

/** utils específicas */

function lock(batch: MilkBatch, fields: string[]) {
  const set = new Set([...(batch.lockedFields || []), ...fields]);
  batch.lockedFields = Array.from(set);
}

function requireProcessed(batch: MilkBatch) {
  if (!batch.processing) throw new Error("Lote ainda não processado (UHT/PASTEURIZED)");
}

function toNumOrUndef(x: any): number | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  const n = Number(x);
  if (Number.isNaN(n)) throw new Error(`Número inválido: ${x}`);
  return n;
}