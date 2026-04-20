import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  computeFileHash,
  CHAT_MODEL,
  genai
} from "../lib";
import { google } from "googleapis";
import { listPdfFilesInFolder, downloadPdfFromDrive, getAuthClient } from "../lib/google-drive-pdfs-exporter";

// 1. Setup Environment and Clients
dotenv.config({ path: ".env.local" });

const prisma = new PrismaClient();

// Function to count pages in a PDF using pdfinfo (from poppler-utils)
async function getPageCount(pdfBuffer: Buffer): Promise<number> {
  try {
    // Write buffer to temporary file for pdfinfo
    const tempPath = path.join(process.cwd(), `temp_${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, pdfBuffer);

    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execPromise = promisify(exec);

    const { stdout } = await execPromise(`pdfinfo "${tempPath}" | grep "Pages:" | awk '{print $2}'`);

    // Clean up temp file
    fs.unlinkSync(tempPath);

    return parseInt(stdout.trim()) || 1; // Default to 1 if parsing fails
  } catch (error) {
    console.warn(`Could not determine page count for PDF buffer, defaulting to 1:`, error);
    return 1;
  }
}

async function ingestPDFs() {
  console.log("🚀 Starting Cloud PDF Fact Ingestion Service...");

  // Check for required environment variables
  const pdfOutputFolderId = process.env.GOOGLE_DRIVE_PDF_OUTPUT_FOLDER_ID;
  if (!pdfOutputFolderId) {
    console.error("Error: GOOGLE_DRIVE_PDF_OUTPUT_FOLDER_ID environment variable is not set");
    process.exit(1);
  }

  // Initialize Drive client
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  // 2. List PDF files from Google Drive output folder
  const pdfFiles = await listPdfFilesInFolder(drive, pdfOutputFolderId);
  console.log(`Found ${pdfFiles.length} PDF files in Drive folder. Checking for updates...`);

  let documentsProcessed = 0;
  let documentsSkipped = 0;
  let totalOutputTokens = 0;
  let totalInputTokens = 0;

  for (const file of pdfFiles) {
    try {
      // 4. Download PDF from Drive
      console.log(`Downloading ${file.name} from Google Drive...`);
      const pdfBuffer = await downloadPdfFromDrive(drive, file.id);

      // 5. Generate hash of the PDF buffer for the Cost Gatekeeper
      const currentHash = await computeFileHash(pdfBuffer);

      // 6. Check DB for existing record
      const existingFile = await prisma.sourceFile.findUnique({
        where: { fileName: file.name }
      });

      if (existingFile?.lastHash === currentHash) {
        console.log(`⏩ Skipping ${file.name}: Content matches existing fingerprint.`);
        documentsSkipped++;
        continue;
      }

      // Count pages in the PDF
      const pageCount = await getPageCount(pdfBuffer);
      console.log(`📄 ${file.name} has ${pageCount} pages`);

      console.log(`✨ Extracting Coherent Facts from ${file.name}...`);

      // 7. Gemini Multimodal Fact Extraction
      const prompt = `
        Analyze this document and extract atomic, and coherent facts.
        Choose an appropriate number of facts based on the document's content and density.
        Focus on technical specifications, process steps, and diagram relationships.
      `;

      const result = await genai.models.generateContent({
        model: CHAT_MODEL,
        contents: [
            {text: prompt},
            {
                inlineData: {
                    data: pdfBuffer.toString("base64"),
                    mimeType: "application/pdf",
                },
            },
        ],
        config: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "array",
                items: { type: "string" },
            },
        },
    });

      // Track token usage
      const outputTokens = result.usageMetadata?.candidatesTokenCount ?? 0;
      const inputTokens = result.usageMetadata?.promptTokenCount ?? 0;
      totalOutputTokens += outputTokens;
      totalInputTokens += inputTokens;

      console.log(`📊 Token usage: ${inputTokens} input, ${outputTokens} output`);

      // Parse structured JSON output from Gemini
      const responseText = result.text ?? "";
      const parsed = JSON.parse(responseText);
      const facts: string[] = Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
      if (facts.length === 0) {
        throw new Error("Gemini returned no parseable facts for this document.");
      }

      // 8. Database Transaction: Update the "Single Source of Truth"
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const sourceFile = await tx.sourceFile.upsert({
          where: { fileName: file.name },
          update: {
            lastHash: currentHash,
          },
          create: {
            fileName: file.name,
            lastHash: currentHash,
          },
        });

        // Remove stale facts before inserting new ones
        await tx.fact.deleteMany({ where: { sourceFileId: sourceFile.id } });

        for (const factText of facts) {
          await tx.fact.create({
            data: {
              content: factText,
              sourceFileId: sourceFile.id,
            },
          });
        }
      });

      documentsProcessed++;
      console.log(`✅ Successfully ingested ${facts.length} facts from ${file.name}`);
    } catch (error) {
      console.error(`❌ Failed to process ${file.name}:`, error);
    }
  }

  console.log(`📊 PDF ingestion complete:`);
  console.log(`   • Documents processed: ${documentsProcessed}`);
  console.log(`   • Documents skipped: ${documentsSkipped}`);
  console.log(`   • Total output tokens: ${totalOutputTokens}`);
  console.log(`   • Total input tokens: ${totalInputTokens}`);
}

ingestPDFs()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });