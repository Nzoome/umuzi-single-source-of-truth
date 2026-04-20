/**
 * Triggers PDF export by calling the exportDriveOfficeFilesToPdf function.
 *
 * This script converts Office documents (PPTX, XLSX) and Google Workspace files
 * (Slides, Sheets) to PDF format and uploads them to the configured Google Drive folder.
 *
 * Required env vars:
 *   GOOGLE_DRIVE_FOLDER_ID          – source folder(s) containing files to convert
 *   GOOGLE_DRIVE_PDF_OUTPUT_FOLDER_ID – destination folder for PDF uploads
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL    – service account email for Drive API access
 *   GOOGLE_PRIVATE_KEY              – service account private key
 */

import { config } from "dotenv";
import { exportDriveOfficeFilesToPdf } from "../lib/google-drive-pdfs-exporter";

config({ path: ".env.local" });

async function main() {
  console.log("🚀 Starting PDF export process...");

  try {
    const exportedCount = await exportDriveOfficeFilesToPdf();

    if (exportedCount > 0) {
      console.log(`✅ Successfully exported ${exportedCount} files to PDF format`);
    } else {
      console.log("ℹ️ No files were exported (no convertible files found or already up to date)");
    }
  } catch (error) {
    console.error("❌ PDF export failed:", error);
    process.exit(1);
  }
}

main();