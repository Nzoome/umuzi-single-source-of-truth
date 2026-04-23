import prisma from "../prisma";
import type { FactWithSimilarity } from "../db-types";

/**
 * Cosine similarity between two vectors.
 * Returns 0 when vector shapes mismatch or norms are invalid.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denom) || denom === 0) {
    return 0;
  }

  return dot / denom;
}

/**
 * Build a direct URL to the original Google Drive file.
 * This intentionally references the source document itself, not any exported PDF.
 */
function buildDriveFileUrl(driveFileId: string): string {
  return `https://drive.google.com/open?id=${encodeURIComponent(driveFileId)}`;
}

/**
 * Search Facts by semantic similarity.
 *
 * Note: we compute cosine similarity in application code to avoid relying on
 * a specific DB vector column type for this newer table while rollout stabilises.
 */
export async function searchFactsByEmbedding(
  embedding: number[],
  limit: number = 5,
): Promise<FactWithSimilarity[]> {
  const facts = await prisma.fact.findMany({
    where: {
      embedding_vector: {
        isEmpty: false,
      },
    },
    include: {
      sourceFile: true,
    },
  });

  const scored: FactWithSimilarity[] = facts
    .map((fact) => ({
      ...fact,
      similarity: cosineSimilarity(embedding, fact.embedding_vector),
      source_url: buildDriveFileUrl(fact.sourceFile.driveFileId),
    }))
    .filter((fact) => Number.isFinite(fact.similarity))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

/**
 * Fetch all facts linked to a source file.
 * Used by document expansion once one fact from that source is relevant.
 */
export async function getFactsBySourceFileId(sourceFileId: string) {
  return prisma.fact.findMany({
    where: { sourceFileId },
    include: { sourceFile: true },
    orderBy: { createdAt: "asc" },
  });
}

