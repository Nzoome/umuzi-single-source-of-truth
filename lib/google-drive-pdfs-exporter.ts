import * as fs from "fs";
import * as path from "path";
import { google } from "googleapis";

// Supported MIME types for Google Drive source files and PDF exports.
const MIME = {
  googleSlides: "application/vnd.google-apps.presentation",
  googleSheets: "application/vnd.google-apps.spreadsheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

type DriveClient = ReturnType<typeof google.drive>;

// Optional configuration object for exporting Drive files to PDFs.
interface ExportConfig {
  sourceFolderIdOrUrl?: string;
  outputFolderIdOrUrl?: string;
  localOutputDir?: string;
}

// Actual Google Drive folder for storing exported PDFs
const DEFAULT_OUTPUT_FOLDER_LINK_PLACEHOLDER =
  "https://drive.google.com/drive/folders/1_6Il-kDUDr8mAe9PK1qyWvVkk741LrMv";
const DEFAULT_OUTPUT_FOLDER_PLACEHOLDER = "1_6Il-kDUDr8mAe9PK1qyWvVkk741LrMv";

/**
 * Read the same configured folder IDs as google-docs-reader.ts.
 * Supports comma-separated values in the GOOGLE_DRIVE_FOLDER_ID env var.
 */
function getGoogleDriveFolderIds(): string[] {
  const folderIdEnv = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderIdEnv) {
    throw new Error(
      "GOOGLE_DRIVE_FOLDER_ID must be set in environment variables.",
    );
  }

  return folderIdEnv
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Resolve explicit source folder IDs or fall back to GOOGLE_DRIVE_FOLDER_ID.
 */
function resolveFolderIds(folderIdOrUrl?: string): string[] {
  if (!folderIdOrUrl) {
    return getGoogleDriveFolderIds();
  }

  return folderIdOrUrl
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

/**
 * Extract a Drive folder ID from either a raw ID or a folder URL.
 */
function parseFolderId(folderIdOrUrl: string): string {
  const trimmed = folderIdOrUrl.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

/**
 * Sanitize a filename so it can be safely written to the local filesystem.
 */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

/**
 * Build an authenticated Google Drive client using a service account.
 */
export function getAuthClient() {
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(
    /\\n/g,
    "\n",
  );

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !privateKey) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be set in environment variables.",
    );
  }

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

/**
 * List all convertible files from a single Drive folder, including nested subfolders.
 * This mirrors the recursive folder traversal used by google-docs-reader.ts.
 */
async function listConvertibleFilesInFolder(
  drive: DriveClient,
  folderId: string,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const supportedMimeTypes = [
    MIME.googleSlides,
    MIME.googleSheets,
    MIME.pptx,
    MIME.xlsx,
  ];

  let pageToken: string | undefined;
  do {
    const listResponse: {
      data: {
        files?: Array<{ id?: string | null; name?: string | null; mimeType?: string | null }>;
        nextPageToken?: string | null;
      };
    } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType in ('${supportedMimeTypes.join("','")}')`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 100,
      pageToken,
    });

    for (const file of listResponse.data.files ?? []) {
      if (file.id && file.name && file.mimeType) {
        files.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      }
    }

    pageToken = listResponse.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Recurse into child folders to include all supported Office files in the tree.
  let folderToken: string | undefined;
  do {
    const folderResponse: {
      data: {
        files?: Array<{ id?: string | null; name?: string | null }>;
        nextPageToken?: string | null;
      };
    } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
      fields: "nextPageToken, files(id)",
      pageSize: 100,
      pageToken: folderToken,
    });

    for (const folder of folderResponse.data.files ?? []) {
      if (folder.id) {
        files.push(...await listConvertibleFilesInFolder(drive, folder.id));
      }
    }

    folderToken = folderResponse.data.nextPageToken ?? undefined;
  } while (folderToken);

  return files;
}

/**
 * List convertible files across one or more root Drive folders.
 */
async function listConvertibleFiles(
  drive: DriveClient,
  sourceFolderIds: string[],
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  for (const folderId of sourceFolderIds) {
    files.push(...await listConvertibleFilesInFolder(drive, folderId));
  }
  return files;
}

/**
 * List all PDF files in a specific Google Drive folder.
 */
export async function listPdfFilesInFolder(
  drive: DriveClient,
  folderId: string,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];

  let pageToken: string | undefined;
  do {
    const listResponse: {
      data: {
        files?: Array<{ id?: string | null; name?: string | null; mimeType?: string | null }>;
        nextPageToken?: string | null;
      };
    } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType='${MIME.pdf}'`,
      fields: "nextPageToken, files(id, name, mimeType)",
      pageSize: 100,
      pageToken,
    });

    for (const file of listResponse.data.files ?? []) {
      if (file.id && file.name && file.mimeType) {
        files.push({ id: file.id, name: file.name, mimeType: file.mimeType });
      }
    }

    pageToken = listResponse.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/**
 * Download a PDF file from Google Drive.
 */
export async function downloadPdfFromDrive(
  drive: DriveClient,
  fileId: string,
): Promise<Buffer> {
  const response = await drive.files.get(
    {
      fileId,
      alt: "media",
    },
    { responseType: "arraybuffer" },
  );

  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Export a native Google Slides or Sheets file directly to PDF.
 */
async function exportGoogleFileToPdf(
  drive: DriveClient,
  fileId: string,
): Promise<Buffer> {
  const response = await drive.files.export(
    {
      fileId,
      mimeType: MIME.pdf,
    },
    { responseType: "arraybuffer" },
  );

  return Buffer.from(response.data as ArrayBuffer);
}

/**
 * Convert Office files to Google-native formats, then export them as PDF.
 */
async function convertOfficeToGoogleAndExportPdf(
  drive: DriveClient,
  file: DriveFile,
): Promise<Buffer> {
  const convertedMimeType =
    file.mimeType === MIME.pptx ? MIME.googleSlides : MIME.googleSheets;

  const copied = await drive.files.copy({
    fileId: file.id,
    requestBody: {
      name: `[tmp-convert] ${file.name}`,
      mimeType: convertedMimeType,
    },
    fields: "id",
  });

  const tempFileId = copied.data.id;
  if (!tempFileId) {
    throw new Error(`Drive conversion failed for file ${file.name}: missing temp file id.`);
  }

  try {
    return await exportGoogleFileToPdf(drive, tempFileId);
  } finally {
    await drive.files.delete({ fileId: tempFileId });
  }
}

/**
 * Upload or update a PDF file to the configured Drive output folder.
 */
async function upsertPdfInDriveFolder(
  drive: DriveClient,
  outputFolderId: string,
  outputPdfName: string,
  pdfBuffer: Buffer,
) {
  const existing = await drive.files.list({
    q: `'${outputFolderId}' in parents and trashed=false and name='${outputPdfName.replace(/'/g, "\\'")}' and mimeType='${MIME.pdf}'`,
    fields: "files(id)",
    pageSize: 1,
  });

  const media = {
    mimeType: MIME.pdf,
    body: Buffer.from(pdfBuffer),
  };

  if (existing.data.files?.[0]?.id) {
    await drive.files.update({
      fileId: existing.data.files[0].id,
      media,
    });
    return;
  }

  await drive.files.create({
    requestBody: {
      name: outputPdfName,
      parents: [outputFolderId],
      mimeType: MIME.pdf,
    },
    media,
  });
}

/**
 * Export all supported Drive files to PDF.
 *
 * The source folders default to the same GOOGLE_DRIVE_FOLDER_ID used by google-docs-reader.ts.
 * The output Drive folder is optional and currently defaults to a placeholder Drive folder link.
 * Local copies are only written if localOutputDir is explicitly provided.
 */
export async function exportDriveOfficeFilesToPdf(config: ExportConfig = {}): Promise<number> {
  const sourceFolderIds = resolveFolderIds(config.sourceFolderIdOrUrl).map(parseFolderId);
  const outputFolderId = parseFolderId(
    config.outputFolderIdOrUrl ?? process.env.GOOGLE_DRIVE_PDF_OUTPUT_FOLDER_ID ?? DEFAULT_OUTPUT_FOLDER_LINK_PLACEHOLDER,
  );
  const localOutputDir = config.localOutputDir;
  const shouldUploadToDrive = outputFolderId !== DEFAULT_OUTPUT_FOLDER_PLACEHOLDER;

  if (localOutputDir && !fs.existsSync(localOutputDir)) {
    fs.mkdirSync(localOutputDir, { recursive: true });
  }

  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  const files = await listConvertibleFiles(drive, sourceFolderIds);
  if (files.length === 0) {
    console.log("No convertible Google Drive files found.");
    return 0;
  }

  if (!shouldUploadToDrive) {
    console.log(
      `No Drive output folder configured. PDF upload will be skipped until GOOGLE_DRIVE_PDF_OUTPUT_FOLDER_ID is set.`,
    );
    if (!localOutputDir) {
      console.log(
        "No local output directory provided either, so exports will not be saved anywhere.",
      );
    }
  }

  let exportedCount = 0;
  for (const file of files) {
    try {
      const pdfBuffer =
        file.mimeType === MIME.googleSlides || file.mimeType === MIME.googleSheets
          ? await exportGoogleFileToPdf(drive, file.id)
          : await convertOfficeToGoogleAndExportPdf(drive, file);

      const outputPdfName = `${path.parse(file.name).name}.pdf`;
      if (shouldUploadToDrive) {
        await upsertPdfInDriveFolder(drive, outputFolderId, outputPdfName, pdfBuffer);
      }

      if (localOutputDir) {
        const localFilePath = path.join(localOutputDir, sanitizeFileName(outputPdfName));
        fs.writeFileSync(localFilePath, pdfBuffer);
      }

      exportedCount++;
      console.log(`Exported ${file.name} -> ${outputPdfName}`);
    } catch (error) {
      console.error(`Failed exporting ${file.name} to PDF:`, error);
    }
  }

  return exportedCount;
}
