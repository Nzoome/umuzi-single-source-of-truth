import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { PrismaClient, Prisma } from "@prisma/client";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { 
  computeFileHash, 
  convertToPdf,
  CHAT_MODEL 
} from "../lib";

// 1. Setup Environment and Clients
dotenv.config({ path: ".env.local" });

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Define the "Lane" for 15-page diagram-heavy documents
const RAW_ASSETS_DIR = "./content/raw-assets";
const PROCESSED_DIR = "./content/processed-pdfs";

async function ingestPDFs() {
  console.log("🚀 Starting Coherent Fact Ingestion Service...");

  // 2. Ensure directories exist
  [RAW_ASSETS_DIR, PROCESSED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  const files = fs.readdirSync(RAW_ASSETS_DIR);
  console.log(`Found ${files.length} raw assets. Checking for updates...`);

  for (const fileName of files) {
    const rawPath = path.join(RAW_ASSETS_DIR, fileName);
    let finalPdfPath = rawPath;

    try {
      // 3. Pre-process: Convert non-PDFs (Slides/Sheets) to PDF
      if (!fileName.toLowerCase().endsWith(".pdf")) {
        console.log(`Converting ${fileName} to PDF...`);
        finalPdfPath = await convertToPdf(rawPath, PROCESSED_DIR);
      }

      // 4. Generate hash of the FINAL PDF for the Cost Gatekeeper
      const currentHash = await computeFileHash(finalPdfPath);

      // 5. Check DB for existing record
      const existingFile = await prisma.sourceFile.findUnique({
        where: { fileName }
      });

      if (existingFile?.lastHash === currentHash) {
        console.log(`⏩ Skipping ${fileName}: Content matches existing fingerprint.`);
        continue;
      }

      console.log(`✨ Extracting Coherent Facts from ${fileName}...`);

      // 6. Gemini Multimodal Fact Extraction
      const model = genAI.getGenerativeModel({ model: CHAT_MODEL });
      const pdfBuffer = fs.readFileSync(finalPdfPath);

      const prompt = `
        Analyze this document and extract exactly 50 distinct, atomic, and coherent facts.
        Focus on technical specifications, process steps, and diagram relationships.
        Return the result as a clean JSON array of strings.
      `;
      
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            data: pdfBuffer.toString("base64"),
            mimeType: "application/pdf",
          },
        },
      ]);

      // Clean the response
      const responseText = result.response.text();
      const cleanJson = responseText.replace(/```json|```/g, "").trim();
      const facts: string[] = JSON.parse(cleanJson);

      // 7. Database Transaction: Update the "Single Source of Truth"
      // Explicit typing 'tx' clears the "implicitly has any type" error
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const sourceFile = await tx.sourceFile.upsert({
          where: { fileName },
          update: { lastHash: currentHash },
          create: { fileName, lastHash: currentHash },
        });

        // Remove stale facts before inserting new ones
        await tx.fact.deleteMany({ where: { sourceFileId: sourceFile.id } });

        for (const factText of facts) {
          await tx.fact.create({
            data: {
              content: factText,
              sourceFileId: sourceFile.id,
            }
          });
        }
      });

      console.log(`✅ Successfully ingested ${facts.length} facts from ${fileName}`);
    } catch (error) {
      console.error(`❌ Failed to process ${fileName}:`, error);
    }
  }
}

ingestPDFs()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });