import { google } from "googleapis";
import { createPrivateKey } from "node:crypto";

// Only include file types that belong in this ingestion pipeline.
const MIME_TYPES = {
  googleSlides: "application/vnd.google-apps.presentation",
  googleSheets: "application/vnd.google-apps.spreadsheet",
  pdf: "application/pdf",
  folder: "application/vnd.google-apps.folder",
};

type DriveClient = ReturnType<typeof google.drive>;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
}

/**
 * Read source folder IDs from environment.
 * Supports comma-separated values in the GOOGLE_DRIVE_FOLDER_ID env var.
 */
export function getGoogleDriveFolderIds(): string[] {
  const folderIdEnv = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderIdEnv) {
    throw new Error(
      "GOOGLE_DRIVE_FOLDER_ID must be set in environment variables.",
    );
  }

  return folderIdEnv
    .split(",")
    .map((folderId) => folderId.trim())
    .filter(Boolean);
}

/**
 * Extract a Drive folder ID from either a raw ID or a folder URL.
 */
export function parseFolderId(folderIdOrUrl: string): string {
  const trimmed = folderIdOrUrl.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

/**
 * Resolve explicit source folder IDs or fall back to env variable.
 */
export function resolveSourceFolderIds(sourceFolderIdOrUrl?: string): string[] {
  if (!sourceFolderIdOrUrl) {
    return getGoogleDriveFolderIds();
  }

  return sourceFolderIdOrUrl
    .split(",")
    .map((folderId) => parseFolderId(folderId.trim()))
    .filter(Boolean);
}

/**
 * Build an authenticated Google Drive client using a service account.
 */
export function getAuthClient() {
  const rawPrivateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const privateKey = rawPrivateKey
    ?.replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .trim();

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !privateKey) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY must be set in environment variables.",
    );
  }

  // Fail fast with an actionable message when a malformed key is loaded from env.
  if (
    !privateKey.includes("BEGIN PRIVATE KEY") ||
    !privateKey.includes("END PRIVATE KEY")
  ) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY appears malformed. Ensure it includes full BEGIN/END PRIVATE KEY markers and preserves newline formatting.",
    );
  }

  try {
    createPrivateKey({ key: privateKey, format: "pem" });
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY could not be parsed by Node crypto. Re-copy `private_key` from the service-account JSON and store it with escaped newlines (\\n).",
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
 * List Slides and Sheets from a single Drive folder, including nested subfolders.
 * Recursion keeps the ingestion path agnostic to folder depth.
 */
async function listSlidesAndSheetsInFolder(
  drive: DriveClient,
  folderId: string,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  const supportedMimeTypes = [MIME_TYPES.googleSlides, MIME_TYPES.googleSheets];
  const mimeTypeQuery = supportedMimeTypes
    .map((mimeType) => `mimeType='${mimeType}'`)
    .join(" or ");

  let pageToken: string | undefined;
  do {
    const listResponse: {
      data: {
        files?: Array<{
          id?: string | null;
          name?: string | null;
          mimeType?: string | null;
          modifiedTime?: string | null;
        }>;
        nextPageToken?: string | null;
      };
    } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and (${mimeTypeQuery})`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
      includeItemsFromAllDrives: true,
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
    });

    for (const file of listResponse.data.files ?? []) {
      if (file.id && file.name && file.mimeType) {
        files.push({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          modifiedTime: file.modifiedTime ?? undefined,
        });
      }
    }

    pageToken = listResponse.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Recurse into child folders so one ingestion run covers the full Drive subtree.
  let folderToken: string | undefined;
  do {
    const folderResponse: {
      data: {
        files?: Array<{ id?: string | null; name?: string | null }>;
        nextPageToken?: string | null;
      };
    } = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and mimeType='${MIME_TYPES.folder}'`,
      fields: "nextPageToken, files(id)",
      includeItemsFromAllDrives: true,
      pageSize: 100,
      pageToken: folderToken,
      supportsAllDrives: true,
    });

    for (const folder of folderResponse.data.files ?? []) {
      if (folder.id) {
        files.push(...(await listSlidesAndSheetsInFolder(drive, folder.id)));
      }
    }

    folderToken = folderResponse.data.nextPageToken ?? undefined;
  } while (folderToken);

  return files;
}

/**
 * List supported files across one or more root Drive folders.
 */
export async function listSlidesAndSheetsRecursively(
  drive: DriveClient,
  sourceFolderIds: string[],
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  for (const folderId of sourceFolderIds) {
    files.push(...(await listSlidesAndSheetsInFolder(drive, folderId)));
  }
  return files;
}

/**
 * Export a native Google Slides or Sheets file directly to PDF.
 */
export async function exportDriveGoogleFileToPdf(
  drive: DriveClient,
  fileId: string,
): Promise<Buffer> {
  const response = await drive.files.export(
    {
      fileId,
      mimeType: MIME_TYPES.pdf,
    },
    { responseType: "arraybuffer" },
  );

  return Buffer.from(response.data as ArrayBuffer);
}
