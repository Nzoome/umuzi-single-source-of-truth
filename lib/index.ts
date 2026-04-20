// Re-export database utilities
export { default as prisma } from "./prisma";
export * from "./db-types";
export * as slabContentRepo from "./repositories/slab-content";
export * as googleDocsContentRepo from "./repositories/google-docs-content";
export * as questionsRepo from "./repositories/questions-asked";
export { computeFileHash } from "./hash";

// Content ingestion utilities
export { loadAllDocuments } from "./content-reader";
export type { MarkdownDocument } from "./content-reader";
export { loadAllGoogleDocs } from "./google-docs-reader";
export type { GoogleDoc } from "./google-docs-reader";
export { chunkDocument, chunkAllDocuments } from "./chunker";
export type { ContentChunk } from "./chunker";

// Gemini AI (LLM + embeddings)
export { genai, embedText, embedTexts, generateText } from "./gemini";
export { EMBEDDING_MODEL, CHAT_MODEL } from "./gemini";
export { embedAllChunks } from "./embeddings";
export type { ChunkWithEmbedding } from "./embeddings";

// RAG pipeline
export { askQuestion } from "./rag";
export type { RAGResult } from "./rag";

// Slack message formatting
export { mdToSlack, formatSources } from "./slack-format";