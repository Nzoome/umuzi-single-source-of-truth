import { embedText, generateText } from "./gemini";
import {
  searchByEmbedding,
  getChunksByTitle,
} from "./repositories/slab-content";
import {
  searchGoogleDocsByEmbedding,
  getGoogleDocsChunksByTitle,
} from "./repositories/google-docs-content";
import type { SlabContentWithSimilarity, GoogleDocsContentWithSimilarity } from "./db-types";

// Default number of top relevant chunks to retrieve per source. Can be overridden by caller.
const DEFAULT_TOP_N = 10;

// Relevance threshold for retrieved chunks (0 to 1). Chunks with similarity below this will be discarded.
const RELEVANCE_THRESHOLD = 0.3;

// Unified source type that works for both Slab and Google Docs content
export interface UnifiedChunk {
  id: number;
  title: string;
  chunk_text: string;
  similarity: number;
  source_url: string | null;
  source_type: "slab" | "google_docs";
}

// Interface for the RAG result returned by askQuestion()
export interface RAGResult {
  answer: string;
  sources: UnifiedChunk[];
}

/**
 * Parse the structured JSON response from the LLM.
 *
 * The LLM is instructed to return JSON in the format:
 *   { "answer": "...", "used_sources": ["Title A", "Title B"] }
 *
 * If the response isn't valid JSON (e.g. the model wrapped it in markdown
 * fences or added preamble), we attempt to extract the JSON object from the
 * raw text. When extraction fails entirely we fall back to treating the
 * whole response as the answer with no declared sources.
 */
function parseLLMResponse(raw: string): {
  answer: string;
  usedSources: string[];
} {
  const trimmed = raw.trim();

  // Try to extract a JSON object even if the model wrapped it in ```json fences
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/m);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        answer?: string;
        used_sources?: string[];
      };
      return {
        answer: (parsed.answer ?? trimmed).trim(),
        usedSources: Array.isArray(parsed.used_sources)
          ? parsed.used_sources
          : [],
      };
    } catch {
      // JSON parse failed — fall through
    }
  }

  // Fallback: treat the entire response as the answer, no declared sources
  return { answer: trimmed, usedSources: [] };
}

// Convert a SlabContentWithSimilarity to a UnifiedChunk
function slabToUnified(chunk: SlabContentWithSimilarity): UnifiedChunk {
  return {
    id: chunk.id,
    title: chunk.title,
    chunk_text: chunk.chunk_text,
    similarity: chunk.similarity,
    source_url: chunk.slab_url ?? null,
    source_type: "slab",
  };
}

// Convert a GoogleDocsContentWithSimilarity to a UnifiedChunk
function googleDocsToUnified(chunk: GoogleDocsContentWithSimilarity): UnifiedChunk {
  return {
    id: chunk.id,
    title: chunk.title,
    chunk_text: chunk.chunk_text,
    similarity: chunk.similarity,
    source_url: chunk.doc_url ?? null,
    source_type: "google_docs",
  };
}

// Helper function to build the prompt for the LLM, combining the question and retrieved context chunks.
function buildPrompt(
  question: string,
  chunks: UnifiedChunk[],
): string {
  const contextBlock = chunks
    .map(
      (chunk, i) =>
        `--- Source ${i + 1}: "${chunk.title}" (similarity: ${chunk.similarity.toFixed(3)}) ---\n${chunk.chunk_text}`,
    )
    .join("\n\n");

  return `You are Zazu, an internal assistant for Umuzi staff.
Answer the question below using ONLY the provided context. If the context
does not contain enough information to answer, say so honestly rather than
guessing.

Keep answers clear, concise, and well-structured. Use bullet points or
numbered lists when appropriate.

IMPORTANT: Respond with a JSON object and nothing else. The JSON must have:
- "answer": your full answer text.
- "used_sources": an array of the exact document titles you actually
  referenced in your reasoning. Only include a title if the document
  genuinely influenced your answer. Use an empty array if none were used.

Example response format:
{"answer": "Your answer here...", "used_sources": ["Document Title A"]}

--- CONTEXT ---
${contextBlock}

--- QUESTION ---
${question}`;
}

/**
 * Full RAG pipeline:
 * 1. Embed the user's question via Gemini.
 * 2. Query pgvector for the top-N most relevant chunks from BOTH tables.
 * 3. Filter out chunks below the relevance threshold.
 * 4. Expand to all chunks from every matched document.
 * 5. Build a prompt with the retrieved context and generate an answer.
 *
 * @param question  – the user's natural-language question.
 * @param topN      – how many chunks to retrieve per source in the initial
 *                    similarity search (default 10).
 * @returns The generated answer together with the source chunks used.
 */
export async function askQuestion(
  question: string,
  topN: number = DEFAULT_TOP_N,
): Promise<RAGResult> {
  // 1. Convert question into a 768-dim embedding
  const questionEmbedding = await embedText(question);

  // 2. Search both tables simultaneously
  const [slabChunks, googleDocsChunks] = await Promise.all([
    searchByEmbedding(questionEmbedding, topN),
    searchGoogleDocsByEmbedding(questionEmbedding, topN),
  ]);

  // 3. Convert to unified format and merge
  const allChunks: UnifiedChunk[] = [
    ...slabChunks.map(slabToUnified),
    ...googleDocsChunks.map(googleDocsToUnified),
  ];

  // 4a. Filter out low-relevance results
  const relevantChunks = allChunks.filter(
    (chunk) => chunk.similarity >= RELEVANCE_THRESHOLD,
  );

  // 4b. Document expansion — fetch ALL chunks from every matched document
  const uniqueSlabTitles = [
    ...new Set(
      relevantChunks
        .filter((c) => c.source_type === "slab")
        .map((c) => c.title),
    ),
  ];
  const uniqueGoogleDocsTitles = [
    ...new Set(
      relevantChunks
        .filter((c) => c.source_type === "google_docs")
        .map((c) => c.title),
    ),
  ];

  const [slabExpansions, googleDocsExpansions] = await Promise.all([
    Promise.all(uniqueSlabTitles.map((title) => getChunksByTitle(title))),
    Promise.all(uniqueGoogleDocsTitles.map((title) => getGoogleDocsChunksByTitle(title))),
  ]);

  // Merge expanded chunks with original results, deduplicating by id + source_type
  const seenIds = new Set(relevantChunks.map((c) => `${c.source_type}-${c.id}`));
  const minSimilarityByTitle = new Map<string, number>();
  for (const c of relevantChunks) {
    const prev = minSimilarityByTitle.get(c.title) ?? c.similarity;
    minSimilarityByTitle.set(c.title, Math.min(prev, c.similarity));
  }

  const expandedChunks: UnifiedChunk[] = [...relevantChunks];

  for (const docChunks of slabExpansions) {
    for (const chunk of docChunks) {
      const key = `slab-${chunk.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        expandedChunks.push({
          ...slabToUnified({ ...chunk, similarity: minSimilarityByTitle.get(chunk.title) ?? RELEVANCE_THRESHOLD }),
        });
      }
    }
  }

  for (const docChunks of googleDocsExpansions) {
    for (const chunk of docChunks) {
      const key = `google_docs-${chunk.id}`;
      if (!seenIds.has(key)) {
        seenIds.add(key);
        expandedChunks.push({
          ...googleDocsToUnified({ ...chunk, similarity: minSimilarityByTitle.get(chunk.title) ?? RELEVANCE_THRESHOLD }),
        });
      }
    }
  }

  // Sort by similarity descending
  expandedChunks.sort((a, b) => b.similarity - a.similarity);

  // 5. If nothing relevant was found, return a "no info" answer
  if (expandedChunks.length === 0) {
    return {
      answer:
        "I couldn't find any relevant information in the knowledge base to answer your question. " +
        "Try rephrasing, or reach out to the relevant team directly.",
      sources: [],
    };
  }

  // 6. Build the augmented prompt and generate an answer
  const prompt = buildPrompt(question, expandedChunks);
  const rawAnswer = await generateText(prompt);

  // 7. Parse structured response and keep only the sources the LLM declared it used
  const { answer, usedSources } = parseLLMResponse(rawAnswer);

  const matchedSources =
    usedSources.length > 0
      ? expandedChunks.filter((doc) =>
          usedSources.some(
            (title) => title.toLowerCase() === doc.title.toLowerCase(),
          ),
        )
      : [];

  // Deduplicate by title + source_type, keeping the chunk with the highest similarity score
  const seenTitles = new Map<string, UnifiedChunk>();
  for (const doc of matchedSources) {
    const key = `${doc.source_type}-${doc.title.toLowerCase()}`;
    const existing = seenTitles.get(key);
    if (!existing || doc.similarity > existing.similarity) {
      seenTitles.set(key, doc);
    }
  }
  const citedSources = Array.from(seenTitles.values());

  return { answer, sources: citedSources };
}