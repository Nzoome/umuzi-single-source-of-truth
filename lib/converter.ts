import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execPromise = promisify(exec);

/**
 * Converts various file formats (Slides, Sheets, Docs) to PDF for Gemini native understanding.
 * This preserves visual layouts and diagrams for multimodal fact extraction.
 * * Requirements: LibreOffice (soffice) must be installed on the host system.
 */
export async function convertToPdf(inputPath: string, outputDir: string): Promise<string> {
  try {
    // 1. Ensure the output directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const ext = path.extname(inputPath).toLowerCase();
    console.log(`Converting ${ext} file to PDF: ${path.basename(inputPath)}`);

    /**
     * Uses LibreOffice headless mode. 
     * --headless: Runs without a GUI.
     * --convert-to pdf: Specifies the output format.
     * --outdir: Specifies where the resulting PDF should be saved.
     */
    await execPromise(`soffice --headless --convert-to pdf "${inputPath}" --outdir "${outputDir}"`);
    
    // 2. Determine the path of the generated PDF
    const fileName = path.basename(inputPath, ext) + ".pdf";
    const finalPath = path.join(outputDir, fileName);

    if (!fs.existsSync(finalPath)) {
      throw new Error(`PDF generation failed: ${finalPath} not found.`);
    }

    return finalPath;
  } catch (error) {
    console.error("Conversion failed:", error);
    throw new Error(`Could not convert ${inputPath} to PDF for multimodal processing.`);
  }
}