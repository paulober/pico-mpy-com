import { ok } from "assert";
import { createHash } from "crypto";
import { readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, relative } from "path";

/**
 * Options for the local scan function.
 */
export interface ScanOptions {
  folderPath: string;
  fileTypes: string[];
  ignoredWildcardItems: string[];
  // only supported for native host paths
  ignoredPaths: string[];
}

/**
 * Sanitize a path by replacing backslashes with forward slashes and removing
 * multi slashes.
 *
 * @param path The path to sanitize.
 * @returns The sanitized path.
 */
export function sanitizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

export function wrapWithSlash(path: string): string {
  const newPath = path.endsWith("/") ? path : path + "/";

  return newPath.startsWith("/") ? newPath : "/" + newPath;
}

export function removeLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.substring(1) : path;
}

export function removeTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function removeTrailingAndLeadingSlash(path: string): string {
  return removeTrailingSlash(path.startsWith("/") ? path.substring(1) : path);
}

/**
 * Ground a folder path by removing the remote base directory.
 *
 * @param folderPath The folder path to ground.
 * @param remoteBaseDir The remote base directory.
 * @returns The grounded folder path.
 */
export function groundFolderPath(
  folderPath: string,
  remoteBaseDir?: string
): string {
  if (!remoteBaseDir) {
    return folderPath;
  }
  const remoteBaseDirSanitized = removeTrailingAndLeadingSlash(remoteBaseDir);
  const fp = removeLeadingSlash(folderPath);

  ok(fp.startsWith(remoteBaseDirSanitized));

  return fp.replace(remoteBaseDirSanitized, "/");
}

/**
 * Check if a file is ignored by the ignoredItems list.
 *
 * @param ignoredItems Ignore items are relative the project folder paths to ignore
 * (can directly exclude a certain file or a folder)
 * or **\/item to ignore all items with that name.
 * @param filePath File path to check.
 * @returns true if not ignored, false if ignored
 */
export function ignoreHelper(
  wildcardIgnoredItems: string[],
  ignoredItems: string[],
  filePath: string
): boolean {
  // assume ignored items are already sanitized
  const fp = sanitizePath(removeTrailingSlash(`/${filePath}`));
  const bn = basename(filePath);

  return (
    !wildcardIgnoredItems.some(
      item =>
        bn === removeTrailingAndLeadingSlash(item.substring(3)) ||
        fp.includes(`/${removeTrailingAndLeadingSlash(item.substring(3))}/`)
    ) &&
    !ignoredItems.some(
      ii =>
        fp === removeTrailingSlash(ii.startsWith("/") ? ii : `/${ii}`) ||
        fp.startsWith(wrapWithSlash(ii))
    )
  );
}

/**
 * Scan a folder and return a map of file paths and their hashes. (recursive)
 *
 * @param options The scan options.
 * @returns The map of file paths and their hashes.
 */
export function scanFolder(options: ScanOptions): Map<string, string> {
  const result = new Map<string, string>();
  const { folderPath, fileTypes, ignoredWildcardItems, ignoredPaths } = options;
  const fts = fileTypes.map(item => (item.startsWith(".") ? item : `.${item}`));

  function scanDir(dir: string): void {
    const items = readdirSync(dir);

    for (const item of items) {
      const itemPath = join(dir, item);

      let relPath = sanitizePath(relative(folderPath, itemPath));
      relPath = relPath.startsWith("/") ? relPath : `/${relPath}`;
      if (ignoreHelper(ignoredWildcardItems, ignoredPaths, relPath) === false) {
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
