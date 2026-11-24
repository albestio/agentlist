import { open, readFile, stat } from "node:fs/promises";

/**
 * Largest file the scanner reads whole. Anything bigger is read from a bounded
 * head: a stray multi-gigabyte `.md` would otherwise be loaded into memory just
 * to build a 1200-character preview.
 */
export const MAX_SCAN_BYTES = 1_000_000;

/**
 * Reads a file for scanning, never more than MAX_SCAN_BYTES.
 *
 * `bytes` is always the real file size, so a caller can still report "showing a
 * preview of an N-byte file" without holding all of it. `complete` is false when
 * the text is only the head of a bigger file.
 */
export async function readBoundedText(path) {
  const info = await stat(path);
  if (!info.isFile()) {
    const error = new Error("Not a file: " + path);
    error.code = "EISDIR";
    throw error;
  }
  if (info.size <= MAX_SCAN_BYTES) {
    return { text: await readFile(path, "utf8"), bytes: info.size, complete: true };
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_SCAN_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_SCAN_BYTES, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: info.size, complete: false };
  } finally {
    await handle.close();
  }
}
