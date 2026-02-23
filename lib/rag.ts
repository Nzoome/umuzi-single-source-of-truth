import { embedText, generateText } from "./gemini";
import { searchByEmbedding } from "./repositories/slab-content";
import type { SlabContentWithSimilarity } from "./db-types";

// Default number of top relevant chunks to retrieve for context. Can be overridden by caller.
const DEFAULT_TOP_N = 5;

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

// Relevance threshold for retrieved chunks (0 to 1). Chunks with similarity below this will be discarded.
const RELEVANCE_THRESHOLD = 0.3;

// Interface for the RAG result returned by askQuestion()
export interface RAGResult {
  answer: string;
  sources: SlabContentWithSimilarity[];
}

// Helper function to build the prompt for the LLM, combining the question and retrieved context chunks.
function buildPrompt(
  question: string,
  chunks: SlabContentWithSimilarity[],
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
 * 2. Query pgvector for the top-N most relevant content chunks.
 * 3. Filter out chunks below the relevance threshold.
 * 4. Build a prompt with the retrieved context and generate an answer.
 *
 * @param question  – the user's natural-language question.
 * @param topN      – how many chunks to retrieve (default 5).
 * @returns The generated answer together with the source chunks used.
 */
export async function askQuestion(
  question: string,
  topN: number = DEFAULT_TOP_N,
): Promise<RAGResult> {
  // 1. Convert question into a 768-dim embedding
  const questionEmbedding = await embedText(question);

  // 2. Retrieve the most similar chunks from pgvector
  const topChunks = await searchByEmbedding(questionEmbedding, topN);

  // 3. Filter out low-relevance results
  const relevantChunks = topChunks.filter(
    (chunk) => chunk.similarity >= RELEVANCE_THRESHOLD,
  );

  // 4. If nothing relevant was found, return a "no info" answer
  if (relevantChunks.length === 0) {
    return {
      answer:
        "I couldn't find any relevant information in the knowledge base to answer your question. " +
        "Try rephrasing, or reach out to the relevant team directly.",
      sources: [],
    };
  }

  // 5. Build the augmented prompt and generate an answer
  const prompt = buildPrompt(question, relevantChunks);
  const rawAnswer = await generateText(prompt);

  // 6. Parse structured response and keep only the sources the LLM declared it used
  const { answer, usedSources } = parseLLMResponse(rawAnswer);

  const citedSources =
    usedSources.length > 0
      ? relevantChunks.filter((doc) =>
          usedSources.some(
            (title) => title.toLowerCase() === doc.title.toLowerCase(),
          ),
        )
      : []; // fallback: return all if parsing produced no titles

  return { answer, sources: citedSources };
}
