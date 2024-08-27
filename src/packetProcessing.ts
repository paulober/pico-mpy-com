import { execSync } from "child_process";
import type FileData from "./fileData.js";
import { existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";

// Contains utilities for parsing the output of commands from the board
// or to format command arguments for usage on the board.

/**
 * Parses the output of a the listContents command.
 * This includes listContentsRecursive and listContents.
 *
 * @param data The response from the command.
 * @returns The list of files and directories.
 */
export function parseListContentsPacket(data: string): FileData[] {
  const files: FileData[] = [];
  for (const line of data.replaceAll("\r", "").split("\n")) {
    if (line === "") {
      continue;
    }

    const parts = line.trimStart().split(" ");

    if (parts.length < 2) {
      continue;
    }

    const filePath = parts.slice(1).join(" ");

    const file: FileData = {
      path: filePath,
      isDir: filePath.endsWith("/"),
      size: parseInt(parts[0]),
    };
    files.push(file);
  }

  return files;
}

/**
 * Aka "mkdir -p" for each folder in folders.
 *
 * NOTE: this function does not create the folders,
 * it just returns the list of folders to create with
 * parents first.
 *
 * @param folders List of folders to create recursively.
 * @returns The list of folders with the parent directories prepended.
 */
export function prependParentDirectories(folders: string[]): string[] {
  const parentDirs = new Set<string>();

  folders.forEach(folder => {
    const components = folder.split("/");
    let path = "";

    components.forEach(component => {
      if (component) {
        path += `/${component}`;
        parentDirs.add(path);
      }
    });
  });

  return Array.from(parentDirs).sort();
}

export interface HashResponse {
  file: string;
  hash?: string;
  error?: string;
}

/**
 * Check if an array of HashResponse objects includes a hash for a specific file.
 *
 * @param responses The array of HashResponse objects.
 * @param file The file to check for.
 * @returns True if the file is in the array, false otherwise.
 */
export function hasFile(responses: HashResponse[], file: string): boolean {
  return responses.some(response => response.file === file);
}

/**
 * Get the hash for a specific file from an array of HashResponse objects.
 *
 * @param responses The array of HashResponse objects.
 * @param file The file to get the hash for.
 * @returns The hash or undefined if the file is not in the array.
 */
export function getHashFromResponses(
  responses: HashResponse[],
  file: string
): string | undefined {
  return responses.find(response => response.file === file)?.hash;
}

export function parseHashJson(data: string): HashResponse {
  return JSON.parse(data);
}

export interface StatResponse {
  creationTime: number;
  modificationTime: number;
  size: number;
  isDir: boolean;
}

export function parseStatJson(data: string): StatResponse {
  return JSON.parse(data);
}

/**
 * Uses python built-in abstract syntax tree (ast) module to wrap
 * the provided Python code with print statements for each expression
 * where necessary.
 *
 * @param pythonExe The Python executable to use.
 * @param code The Python code to wrap.
 * @returns The wrapped Python code or unmodified code if an error occurred.
 */
export function wrapExpressionWithPrint(
  pythonExe: string,
  code: string
): string {
  /* class PrintWrapper(ast.NodeTransformer):
    def visit_Expr(self, node):
        if not (isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name) and node.value.func.id == "print"):
            new_node = ast.Expr(value=ast.Call(
                func=ast.Name(id='print', ctx=ast.Load()),
                args=[node.value],
                keywords=[]
            ))
            return new_node
        return node

def wrap_expressions_with_print(code):
    try:
        tree = ast.parse(code)
        wrapped_tree = PrintWrapper().visit(tree)
        wrapped_code = ast.unparse(wrapped_tree)
        return wrapped_code
    except Exception:
        return code*/
  const escapedCode = code
    .replaceAll(/"/g, '\\"')
    .replaceAll(/'/g, "\\'")
    // as the command for executing python doesn't support multiline
    .replaceAll(/\n/g, "\\n");
  // eslint-disable-next-line max-len
  const oneLiner = `import ast; wrap_expressions_with_print=lambda code:ast.unparse(PrintWrapper().visit(ast.parse(code))) if not isinstance(None,Exception) else code; PrintWrapper=type('PrintWrapper',(ast.NodeTransformer,),{'visit_Expr':lambda self,node:(ast.Expr(value=ast.Call(func=ast.Name(id='print',ctx=ast.Load()),args=[node.value],keywords=[])) if not (isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='print') else node)}); print(wrap_expressions_with_print('''${escapedCode}'''))`;

  try {
    // Execute the Python code using the provided Python executable
    const result = execSync(`${pythonExe} -c "${oneLiner}"`, {
      encoding: "utf8",
      // Timeout after 10 seconds
      timeout: 10 * 1000,
      stdio: [
        "ignore", // stdin
        "pipe", // stdout
        "ignore", // stderr
      ],
    });

    return result;
  } catch {
    return code;
  }
}

/**
 * Converts the rp2 datetime format to a standard V8 Date object
 *
 * @param datetime The rp2 rtc.datetime() format: (yyyy, m, d, weekday, h, m, s, 0)
 * weekday: 0 = Monday, 1 = Tuesday, ..., 6 = Sunday
 * 0 because the rp2 does not support subseconds/milliseconds
 */
export function rp2DatetimeToDate(datetime: string): Date | null {
  const match =
    // eslint-disable-next-line max-len
    /^\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(\d{1,2}),\s*(?:\d{1,2})\)$/gm.exec(
      datetime
    );
  if (!match) {
    return null;
  }

  const [, year, month, day, , hour, minute, second] = match.map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return new Date(year, month - 1, day, hour, minute, second);
}

/**
 * Converts a Date object to the rp2 datetime format tuple
 *
 * @param date Normal V8 Date object
 * @returns
 */
export function dateToRp2Datetime(date: Date): string {
  const year = date.getFullYear();
  // month is 0-based but the rp2 datetime format is 1-based
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();

  // subseconds are hardware dependant and not supported by the rp2
  // therefore we always set it to 0
  // TODO: maybe still transfer it for boards that support it
  return (
    `(${year}, ${month}, ${day}, ${date.getDay()}, ` +
    `${hour}, ${minute}, ${second}, 0)`
  );
}

export function sanitizeRemote(path?: string): string {
  /*if (!path || path === "") {
    return ":";
  } else if (!path.startsWith(":")) {
    return `:${path}`;
  } else {
    return path;
  }*/

  if (path && path !== "" && path.startsWith(":")) {
    return path.slice(1);
  }

  return path ?? "/";
}

export function standardizePath(
  localBaseDir: string,
  local: string[]
): Array<[string, string]> {
  // Create a list of tuples with original and modified paths
  const destinations: Array<[string, string]> = local.map(filePath => {
    const destPath = filePath
      .replace(localBaseDir, "/")
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");

    return [filePath, destPath];
  });

  // Sort by the number of '/' in the modified paths
  destinations.sort((a, b) => a[1].split("/").length - b[1].split("/").length);

  return destinations;
}

export function createFolderStructure(
  filePaths: string[],
  localFolderPath: string
): void {
  filePaths.forEach(filePath => {
    // Remove leading ':' and '/' from the file path
    const normalizedPath = filePath.replace(/^[:/]+/, "");
    // Create the full path by joining with the local folder path
    const fullPath = join(localFolderPath, normalizedPath);
    // Get the directory path
    const dirPath = dirname(fullPath);

    // Create the directory structure if it doesn't exist
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  });
}
