import * as dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import type { GoogleGenAI } from "@google/genai";
import { Prisma } from "../lib/generated/prisma";
import {
  exportDriveGoogleFileToPdf,
  getAuthClient,
  listSlidesAndSheetsRecursively,
  resolveSourceFolderIds,
  type DriveFile,
} from "../lib/google-drive-pdfs-exporter";
import type { PrismaClient } from "../lib/generated/prisma";

dotenv.config({ path: ".env.local" });

let CHAT_MODEL: string;
let computeFileHash: (input: Buffer) => Promise<string>;
let embedTexts: (
  texts: string[],
  taskType?: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY",
) => Promise<number[][]>;
let genai: GoogleGenAI;
let prisma: PrismaClient;
const CONCURRENCY_LIMIT = 3;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

type IngestionStats = {
  processed: number;
  skipped: number;
  failed: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};

/**
 * Sleep helper used by retry backoff and rate-limit friendly pauses.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an async task with exponential backoff.
 * This prevents transient Drive/Gemini errors from failing the full run.
 */
async function withRetry<T>(task: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) {
        break;
      }

      const backoffMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `Retrying ${label} (attempt ${attempt + 1}/${MAX_RETRIES}) in ${backoffMs}ms...`,
      );
      await delay(backoffMs);
    }
  }

  throw new Error(`Failed after ${MAX_RETRIES} attempts: ${label}\n${String(lastError)}`);
}

type SourceType = "slides" | "sheets";

function buildFactExtractionPrompt(sourceType: SourceType): string {
  const common = `
You are extracting factual statements from a document for a knowledge base.
Return ONLY a JSON array of strings.
Each string must be one concise, atomic, and standalone fact.
Do not invent facts.
Remove duplicates and near-duplicates.
Skip purely decorative or repeated footer/header text.

Standalone requirement (strict):
- Every fact must be understandable in isolation, without needing the document title, surrounding rows/slides, or prior facts.
- Every fact must include a clear subject/entity (for example: project name, team, person, role, system, policy, process, metric, or document section).
- Replace vague references (for example: "it", "this", "they", "the project", "the team") with explicit names from the document whenever possible.
- Include relevant context when applicable: scope, timeframe/date period, ownership/responsible party, and purpose/intent.
- First attempt to rewrite a candidate statement into a self-contained fact using visible information; only skip it if that still cannot be done reliably.

Specificity requirement:
- Avoid vague qualifiers such as "significant", "various", "several", "many", "strong", or "core" unless the document itself specifies what they mean.
- Prefer concrete, specific facts over high-level summaries when more precise details are visible.
- Include relationships between entities whenever possible, for example: person -> role -> project, metric -> target -> timeframe, team -> responsibility -> system/process.
- Prefer explicit numbers, names, thresholds, dates, owners, statuses, and linked entities over abstract summaries.

Deduplication requirement:
- Remove, merge, or avoid semantically equivalent facts even if they are phrased differently.
- If two candidate facts express the same meaning, keep the more specific and informative version.

Examples:
- Bad: "The budget is 10,000 rand."
- Good: "The Umuzi Career Sprint pilot budget for Q3 2026 is 10,000 rand."
- Bad: "It must be approved before launch."
- Good: "The website overhaul launch plan must be approved by the Product Lead before launch."
- Bad: "The project received significant investment."
- Good: "The Innovation Strategy 2026 project received a 2 million rand budget allocation for the 2026 financial year."
`.trim();

  if (sourceType === "slides") {
    return `
${common}

This document is an exported PDF of a Google Slides deck.
Be exhaustive: include facts from headings, bullets, diagrams, callouts, and speaker-style notes visible in the slides.
Capture process steps, policies/rules, definitions, roles/responsibilities, relationships, and any numbers/dates/thresholds mentioned.
Split multi-part statements into separate facts.
`.trim();
  }

  return `
${common}

This document is an exported PDF of a Google Sheets workbook.
First, infer the workbook type (one or more): timeline/project plan, budget/finance, dashboard/KPI report, tracker/register/log, roster/schedule, or reference.
Then extract facts using the rules below.

Universal rules (apply to all workbook types):
- Be exhaustive about schema + rules: capture column/field definitions, status meanings, validation rules, required fields, and any process instructions.
- Prefer "schema + rules + summaries" over raw row dumps. Do NOT enumerate every row or every cell.
- Capture concrete details: names, dates, numbers, thresholds, targets, limits, owners, dependencies, and exceptions (if/unless/only when/not allowed).
- If a table implies meaning via headers, extract that meaning as facts.
- If the PDF view truncates wide tables or hides content, extract only what is visible and do not guess missing values/columns.
- Split multi-part statements into separate facts.

Type-specific focus:
- Timeline / project plan: milestones, key dates/deadlines, dependencies, owners, status rules; avoid listing every task row unless clearly marked as a milestone/critical.
- Budget / finance: category definitions, totals/subtotals, budget limits, approval rules, variances/overruns, recurring costs; avoid listing all line items unless they are explicitly highlighted as important.
- Dashboard / KPI report: KPI definitions and formulas, targets/thresholds, reporting cadence, scope/filters, and any written insights; avoid repeating raw time series rows.
- Tracker / register / log: column meanings, allowed values, SLAs/escalation rules, how to interpret flags/tags; avoid enumerating records.
- Roster / schedule: coverage rules, rotation rules, constraints, handover rules; avoid listing every person/shift unless the row itself encodes a rule/policy.
`.trim();
}

/**
 * Extract fact strings from a PDF using Gemini multimodal input.
 * JSON mode keeps output deterministic and easy to persist.
 */
async function extractFactsFromPdf(
  pdfBuffer: Buffer,
  sourceType: SourceType,
): Promise<{
  facts: string[];
  inputTokens: number;
  outputTokens: number;
}> {
  const prompt = buildFactExtractionPrompt(sourceType);

  type GenerateContentArgs = Parameters<GoogleGenAI["models"]["generateContent"]>[0];

  const result = await withRetry(
    async () =>
      // Treat extraction instructions as a system message, and the PDF as user-provided input.
      // The Gemini SDK supports role-based "contents" for clearer separation of instructions.
      genai.models.generateContent({
        model: CHAT_MODEL,
        contents: [
          { role: "system", parts: [{ text: prompt }] },
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  data: pdfBuffer.toString("base64"),
                  mimeType: "application/pdf",
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "array",
            items: { type: "string" },
          },
        },
      } as unknown as GenerateContentArgs),
    "Gemini fact extraction",
  );

  const raw = result.text ?? "[]";
  const parsed = JSON.parse(raw);
  const facts =
    Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];

  return {
    facts,
    inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * Replaces all facts for a source file in a single transaction.
 * We fully replace facts to ensure DB state always reflects latest source version.
 */
async function upsertFileFacts(
  tx: Prisma.TransactionClient,
  file: DriveFile,
  currentHash: string,
  facts: string[],
  embeddings: number[][],
): Promise<void> {
  const sourceFile = await tx.sourceFile.upsert({
    where: { driveFileId: file.id },
    update: {
      fileName: file.name,
      mimeType: file.mimeType,
      driveModifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
      lastHash: currentHash,
    },
    create: {
      driveFileId: file.id,
      fileName: file.name,
      mimeType: file.mimeType,
      driveModifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
      lastHash: currentHash,
    },
  });

  await tx.fact.deleteMany({ where: { sourceFileId: sourceFile.id } });

  if (facts.length === 0) return;

  // NOTE: We intentionally do NOT use tx.fact.createMany here.
  // Fact.embedding_vector is pgvector (vector(768)) and Prisma marks it as Unsupported.
  // With createMany, Prisma serializes number[] as a Postgres array literal ("{...}"),
  // which pgvector rejects ("invalid input syntax for type vector").
  // Also include explicit IDs because Prisma's @default(cuid()) is client-side behavior,
  // not a guaranteed DB default for raw SQL inserts.
  // Bulk SQL with explicit ::vector casting is currently the reliable write path.
  await tx.$executeRaw`
    INSERT INTO "Fact" ("id", "content", "sourceFileId", "embedding_vector")
    VALUES ${Prisma.join(
      facts.map((content, index) => {
        const id = randomUUID();
        const embeddingStr = `[${embeddings[index].join(",")}]`;
        return Prisma.sql`(${id}, ${content}, ${sourceFile.id}, ${embeddingStr}::vector)`;
      }),
    )}
  `;
}

/**
 * Processes one Drive file from export -> hash gate -> fact extraction -> embed -> save.
 */
async function processFile(
  drive: ReturnType<typeof google.drive>,
  file: DriveFile,
  stats: IngestionStats,
): Promise<void> {
  console.log(`\n➡️ Processing: ${file.name}`);

  const existingFile = await prisma.sourceFile.findUnique({
    where: { driveFileId: file.id },
  });

  // Stage 1: cheap metadata gate. If Drive modifiedTime is unchanged, skip before
  // export/hash/LLM work to avoid unnecessary cost.
  const incomingModifiedIso = file.modifiedTime
    ? new Date(file.modifiedTime).toISOString()
    : null;
  const existingModifiedIso = existingFile?.driveModifiedTime
    ? new Date(existingFile.driveModifiedTime).toISOString()
    : null;

  if (incomingModifiedIso && existingModifiedIso && incomingModifiedIso === existingModifiedIso) {
    stats.skipped++;
    console.log(`⏩ Skipped: ${file.name} (modifiedTime unchanged)`);
    return;
  }

  const pdfBuffer = await withRetry(
    () => exportDriveGoogleFileToPdf(drive, file.id),
    `export to PDF (${file.name})`,
  );
  const currentHash = await computeFileHash(pdfBuffer);

  if (existingFile?.lastHash === currentHash) {
    // Stage 2: content gate. If bytes are unchanged, persist fresh Drive metadata
    // so future runs can short-circuit at stage 1.
    await prisma.sourceFile.update({
      where: { driveFileId: file.id },
      data: {
        fileName: file.name,
        mimeType: file.mimeType,
        driveModifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
        lastHash: currentHash,
      },
    });
    stats.skipped++;
    console.log(`⏩ Skipped: ${file.name} (hash unchanged)`);
    return;
  }

  const sourceType: SourceType = file.mimeType.includes("presentation")
    ? "slides"
    : "sheets";

  const { facts, inputTokens, outputTokens } = await extractFactsFromPdf(
    pdfBuffer,
    sourceType,
  );
  if (facts.length === 0) {
    throw new Error(`No parseable facts returned for ${file.name}`);
  }

  // Facts are embedded as retrieval documents to support downstream vector search.
  const embeddings = await withRetry(
    () => embedTexts(facts, "RETRIEVAL_DOCUMENT"),
    `embedding facts (${file.name})`,
  );

  await prisma.$transaction((tx: Prisma.TransactionClient) =>
    upsertFileFacts(tx, file, currentHash, facts, embeddings),
  );

  stats.processed++;
  stats.totalInputTokens += inputTokens;
  stats.totalOutputTokens += outputTokens;
  console.log(`✅ Processed: ${file.name} (${facts.length} facts)`);
}

/**
 * Tiny worker pool for bounded parallel processing without extra dependencies.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

async function ingestSlidesAndSheets(): Promise<void> {
  if (!genai || !prisma) {
    const [geminiModule, hashModule, prismaModule] = await Promise.all([
      import("../lib/gemini"),
      import("../lib/hash"),
      import("../lib/prisma"),
    ]);

    // Single shared Gemini client instance lives in lib/gemini.ts
    CHAT_MODEL = geminiModule.CHAT_MODEL;
    embedTexts = geminiModule.embedTexts;
    genai = geminiModule.genai;

    computeFileHash = hashModule.computeFileHash;
    prisma = prismaModule.default;
  }

  console.log("🚀 Starting Drive Slides/Sheets fact ingestion...");

  // Slides/Sheets ingestion can be configured independently from other Drive ingesters.
  // Prefer the dedicated env var, but fall back to the legacy GOOGLE_DRIVE_FOLDER_ID.
  const slidesSheetsFolderEnv =
    process.env.GOOGLE_DRIVE_SLIDES_SHEETS_FOLDER_ID ??
    process.env.GOOGLE_DRIVE_FOLDER_ID;

  const sourceFolderIds = resolveSourceFolderIds(slidesSheetsFolderEnv).map(
    parseFolderIdSafe,
  );
  if (sourceFolderIds.length === 0) {
    throw new Error(
      "No source folder IDs resolved from GOOGLE_DRIVE_SLIDES_SHEETS_FOLDER_ID (or fallback GOOGLE_DRIVE_FOLDER_ID).",
    );
  }

  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  const files = await listSlidesAndSheetsRecursively(drive, sourceFolderIds);
  console.log(`Found ${files.length} eligible files (Slides/Sheets).`);

  const stats: IngestionStats = {
    processed: 0,
    skipped: 0,
    failed: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };

  await runWithConcurrency(files, CONCURRENCY_LIMIT, async (file) => {
    try {
      await processFile(drive, file, stats);
    } catch (error) {
      stats.failed++;
      console.error(`❌ Failed: ${file.name}`, error);
    }
  });

  console.log("\n📊 Ingestion complete");
  console.log(`   • Processed: ${stats.processed}`);
  console.log(`   • Skipped: ${stats.skipped}`);
  console.log(`   • Failed: ${stats.failed}`);
  console.log(`   • Gemini input tokens: ${stats.totalInputTokens}`);
  console.log(`   • Gemini output tokens: ${stats.totalOutputTokens}`);
}

/**
 * Defensive helper for malformed folder strings in env values.
 */
function parseFolderIdSafe(folderIdOrUrl: string): string {
  const trimmed = folderIdOrUrl.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

ingestSlidesAndSheets()
  .catch((error) => {
    console.error("Fatal ingestion error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });
