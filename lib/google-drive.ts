/**
 * Build a direct URL to a Google Drive file.
 * This intentionally references the source document itself (not any exported PDF).
 */
export function buildDriveFileUrl(driveFileId: string): string {
  return `https://drive.google.com/open?id=${encodeURIComponent(driveFileId)}`;
}

