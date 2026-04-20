import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Generates a SHA-256 hash for a file path or a Buffer.
 * This is the "fingerprint" used to detect changes.
 */
export async function computeFileHash(fileOrBuffer: string | Buffer): Promise<string> {
  if (typeof fileOrBuffer === "string") {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(fileOrBuffer);

      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", (err) => reject(err));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  const hash = crypto.createHash("sha256");
  hash.update(fileOrBuffer);
  return hash.digest("hex");
}