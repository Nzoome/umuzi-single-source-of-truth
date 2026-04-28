import prisma from "../prisma";
import type { FactWithSimilarity } from "../db-types";
import { buildDriveFileUrl } from "../google-drive";

/**
 * Search Facts by semantic similarity.
 */
export async function searchFactsByEmbedding(
  embedding: number[],
  limit: number = 5,
): Promise<FactWithSimilarity[]> {
  const embeddingStr = `[${embedding.join(",")}]`;

  // Pull top-N IDs using pgvector cosine distance in the DB.
  const hits = await prisma.$queryRaw<
    Array<{ id: string; similarity: number; sourceFileId: string }>
  >`
    SELECT id, sourceFileId, 1 - (embedding_vector <=> ${embeddingStr}::vector) as similarity
    FROM "Fact"
    WHERE embedding_vector IS NOT NULL
    ORDER BY embedding_vector <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  if (hits.length === 0) return [];

  const idToSimilarity = new Map(hits.map((h) => [h.id, h.similarity]));
  const idsInOrder = hits.map((h) => h.id);

  const facts = await prisma.fact.findMany({
    where: { id: { in: idsInOrder } },
    include: { sourceFile: true },
  });

  const factById = new Map(facts.map((f) => [f.id, f]));

  // Return in similarity order.
  const scored: FactWithSimilarity[] = idsInOrder
    .map((id) => {
      const fact = factById.get(id);
      if (!fact) return null;
      return {
        ...fact,
        similarity: idToSimilarity.get(id) ?? 0,
        source_url: buildDriveFileUrl(fact.sourceFile.driveFileId),
      };
    })
    .filter((f): f is FactWithSimilarity => Boolean(f));

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

