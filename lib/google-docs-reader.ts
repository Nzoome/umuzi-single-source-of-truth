// Reads Google Docs from a configured Drive folder and exports them as Markdown.
// Uses a service account for authentication — no human login required.
// The GOOGLE_DRIVE_FOLDER_ID env variable determines which folder to read from.
// Supports recursive folder traversal — will find docs in subfolders too.

import { google } from "googleapis";

// Authenticate using service account credentials from environment variables
function getAuthClient() {
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
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

// Represents a single Google Doc with its content as Markdown
export interface GoogleDoc {
  id: string;
  title: string;
  content: string;
  url: string;
}

// List all Google Docs in a folder and its subfolders recursively.
// Takes a drive instance to avoid creating a new auth client on every recursive call.
async function listDocsInFolder(
  folderId: string,
  drive: ReturnType<typeof google.drive>,
): Promise<{ id: string; title: string }[]> {
  const docs: { id: string; title: string }[] = [];

  // Find all Google Docs in this folder
  const docsResponse = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`,
    fields: "files(id, name)",
  });

  for (const file of docsResponse.data.files ?? []) {
    docs.push({ id: file.id!, title: file.name! });
  }

  // Find all subfolders in this folder
  const foldersResponse = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });

  // Recursively search each subfolder and add its docs to the list
  for (const folder of foldersResponse.data.files ?? []) {
    const subDocs = await listDocsInFolder(folder.id!, drive);
    docs.push(...subDocs);
  }

  return docs;
}

// Export a single Google Doc as Markdown using the Drive export endpoint
async function exportDocAsMarkdown(
  docId: string,
  drive: ReturnType<typeof google.drive>,
): Promise<string> {
  const response = await drive.files.export(
    {
      fileId: docId,
      mimeType: "text/markdown",
    },
    { responseType: "text" },
  );

  return response.data as string;
}

// Load all Google Docs from one or more configured Drive folders and return them with their content.
// GOOGLE_DRIVE_FOLDER_ID supports multiple comma-separated folder IDs e.g. "123,456,789".
// Searches recursively through subfolders of each folder.
export async function loadAllGoogleDocs(): Promise<GoogleDoc[]> {
  const folderIdEnv = process.env.GOOGLE_DRIVE_FOLDER_ID;

  if (!folderIdEnv) {
    throw new Error(
      "GOOGLE_DRIVE_FOLDER_ID must be set in environment variables.",
    );
  }

  // Support multiple comma-separated folder IDs
  const folderIds = folderIdEnv.split(",").map((id) => id.trim()).filter(Boolean);

  // Create a single auth client and drive instance to reuse across all calls
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  // Collect docs from all folders
  const allFiles: { id: string; title: string }[] = [];
  for (const folderId of folderIds) {
    console.log(`Searching folder: ${folderId}`);
    const files = await listDocsInFolder(folderId, drive);
    allFiles.push(...files);
  }

  if (allFiles.length === 0) {
    return [];
  }

  console.log(`Found ${allFiles.length} Google Docs across ${folderIds.length} folder(s).`);

  const docs: GoogleDoc[] = [];

  for (const file of allFiles) {
    console.log(`  Exporting: ${file.title}`);
    const content = await exportDocAsMarkdown(file.id, drive);
    docs.push({
      id: file.id,
      title: file.title,
      content,
      url: `https://docs.google.com/document/d/${file.id}`,
    });
  }

  return docs;
}