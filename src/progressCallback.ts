import { stat } from "fs/promises";
import type { SerialPort } from "serialport";
import { fsFileSize } from "./serialHelper.js";

/**
 * The callback function that is used to communicate the progress of a file transfer.
 */
export type ProgressCallback = (
  // The total number of chunks to transfer.
  totalChunksCount: number,
  // The number of the last uploaded chunk. | The amount of chunks that have been transferred.
  currentChunk: number,
  // The relative path of the file that is currently being transferred.
  relativePath: string
) => void;

export async function calculateTotalChunksLocal(
  filePaths: string[],
  chunkSize: number
): Promise<number> {
  // calulate total chunks for all files parallel
  const totalChunks = (
    await Promise.all(
      filePaths.map(async (filePath: string): Promise<number> => {
        try {
          const stats = await stat(filePath);
          const fileSize = stats.size;
          const chunks = Math.ceil(fileSize / chunkSize);

          return chunks;
        } catch {
          return 0;
        }
      })
    )
  ).reduce((acc, chunks) => acc + chunks, 0);

  return totalChunks;
}

export async function calculateTotalChunksRemote(
  port: SerialPort,
  filePaths: string[],
  chunkSize: number
): Promise<number> {
  let totalChunks = 0;

  for (const filePath of filePaths) {
    const fileSize = await fsFileSize(port, filePath);
    if (fileSize === undefined) {
      continue;
    }
    const chunks = Math.ceil(fileSize / chunkSize);
    totalChunks += chunks;
  }

  return totalChunks;
}
