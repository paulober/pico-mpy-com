import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { extname, join, relative } from "path";

export interface ScanOptions {
  folderPath: string;
  fileTypes: string[];
  ignoredWildcardItems: string[];
  ignoredPaths: string[];
}

export function scanFolder(options: ScanOptions): Map<string, string> {
  const result = new Map<string, string>();
  const { folderPath, fileTypes, ignoredWildcardItems, ignoredPaths } = options;
  const fts = fileTypes.map(item => (item.startsWith(".") ? item : `.${item}`));

  function scanDir(dir: string): void {
    const items = readdirSync(dir);

    for (const item of items) {
      const itemPath = join(dir, item);

      // Ignore items are file/folder names (not absolute or relative paths)
      if (
        ignoredWildcardItems.includes("**/" + item) ||
        ignoredPaths.includes(relative(folderPath, itemPath))
      ) {
        continue;
      }

      const stat = statSync(itemPath);
      if (stat.isDirectory()) {
        scanDir(itemPath);
      } else if (stat.isFile()) {
        if (fts.length === 0 || fts.includes(extname(item))) {
          const hash = createHash("sha256");
          const data = readFileSync(itemPath);
          hash.update(data);
          const relativePath = relative(folderPath, itemPath);
          result.set(relativePath, hash.digest("hex"));
        }
      }
    }
  }

  scanDir(folderPath);

  return result;
}
