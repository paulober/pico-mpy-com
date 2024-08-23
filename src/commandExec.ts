import type { EventEmitter } from "events";
import type { SerialPort } from "serialport";
import {
  evaluteExpression,
  executeCommand,
  fsGet,
  fsIsDir,
  fsListContents,
  fsMkdir,
  fsPut,
  fsRemove,
  fsRmdir,
  fsRmdirRecursive,
} from "./serialHelper.js";
import { type Command, CommandType } from "./command.js";
import {
  type OperationResult,
  OperationResultType,
} from "./operationResult.js";
import { ok } from "assert";
import {
  createFolderStructure,
  prependParentDirectories,
  sanitizeRemote,
  standardizePath,
} from "./packetProcessing.js";
import { dirname, join, sep } from "path";

/**
 * Execute any type of command on a MicroPython board connected to
 * a serial port and return the result.
 *
 * @param port The port the board is connected to.
 * @param emitter An event emitter.
 * @param command The command to execute.
 * @param receiver A function to receive the data as it comes in. (not supported by all commands)
 * @returns The result of the operation.
 */
export async function executeAnyCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command,
  receiver?: (data: Buffer) => void,
  pythonInterpreterPath?: string
): Promise<OperationResult> {
  switch (command.type) {
    case CommandType.command:
      return executeCommandCommand(
        port,
        emitter,
        command as Command<CommandType.command>,
        receiver
      );

    case CommandType.expression:
      ok(
        pythonInterpreterPath,
        "Python interpreter path must be provided for expression evaluation"
      );

      return executeExpressionCommand(
        port,
        emitter,
        command as Command<CommandType.expression>,
        receiver as (data: Buffer) => void,
        pythonInterpreterPath
      );

    case CommandType.listContents:
      return executeListContentsCommand(
        port,
        emitter,
        command as Command<CommandType.listContents>
      );

    case CommandType.deleteFiles:
      return executeDeleteFilesCommand(
        port,
        emitter,
        command as Command<CommandType.deleteFiles>
      );

    case CommandType.mkdirs:
      return executeMkdirsCommand(
        port,
        emitter,
        command as Command<CommandType.mkdirs>
      );

    case CommandType.rmdirs:
      return executeRmdirsCommand(
        port,
        emitter,
        command as Command<CommandType.rmdirs>
      );

    case CommandType.rmtree:
      return executeRmtreeRecursiveCommand(
        port,
        emitter,
        command as Command<CommandType.rmtree>
      );

    case CommandType.rmFileOrDir:
      return executeRmFileOrDirectoryCommand(
        port,
        emitter,
        command as Command<CommandType.rmFileOrDir>
      );

    // TODO: implementation not finished
    case CommandType.uploadFiles:
      return executeUploadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.uploadFiles>,
        receiver
      );

    // TODO: implementation not finished
    case CommandType.downloadFiles:
      return executeDownloadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.downloadFiles>,
        receiver
      );

    default:
      // "Unknown command type"
      return { type: OperationResultType.none };
  }
}

// TODO: remove all console.debug
// these proxies are used to
// - transform thrown errors into OperationResult objects
// - handle multi command operations like uploading a project
//
// the proxies don't contain platform specific code or command transformations
// they may be moved into executeAnyCommand dispatcher if it's not to much code

/**
 * Operation to execute a Command of type command and return the result.
 */
export async function executeCommandCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.command>,
  receiver?: (data: Buffer) => void
): Promise<OperationResult> {
  try {
    const result = await executeCommand(port, command.args.command, receiver);

    return receiver
      ? { type: OperationResultType.commandResult, result: true }
      : { type: OperationResultType.commandResponse, response: result };
  } catch (error) {
    // TODO: may report error to the emitter or in different way
    // for better destinction between errors and responses, maybe as type .none
    //return error instanceof Error ? error.message : "Unknown error";
    return receiver
      ? { type: OperationResultType.commandResult, result: false }
      : {
          type: OperationResultType.commandResponse,
          response: error instanceof Error ? error.message : "Unknown error",
        };
  }
}

export async function executeExpressionCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.expression>,
  receiver: (data: Buffer) => void,
  pythonInterpreterPath: string
): Promise<OperationResult> {
  try {
    const error = await evaluteExpression(
      port,
      command.args.code,
      pythonInterpreterPath,
      emitter,
      receiver
    );

    if (error) {
      console.debug(`Error evaluating expression: ${error}`);
    }

    return { type: OperationResultType.commandResult, result: error === null };
  } catch (error) {
    console.error(error);

    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Operation to list the contents of a directory on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The contents of the directory.
 */
export async function executeListContentsCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.listContents>
): Promise<OperationResult> {
  ok(command.args.target);
  const result = await fsListContents(port, command.args.target);

  return { type: OperationResultType.listContents, contents: result };
}

export async function executeDeleteFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.deleteFiles>
): Promise<OperationResult> {
  ok(command.args.files);

  let failedDeletions = 0;
  for (const file of command.args.files) {
    try {
      await fsRemove(port, file);
    } catch (error) {
      console.debug(
        `Failed to delete file: ${file} with error: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error"
        }`
      );
      failedDeletions++;
    }
  }

  // TODO: errors must be checked as if a file did not exist in the first place
  // this operation should not be considered as failed
  return { type: OperationResultType.status, status: failedDeletions === 0 };
}

export async function executeMkdirsCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.mkdirs>
): Promise<OperationResult> {
  ok(command.args.folders);

  let failedMkdirs = 0;
  const folders = prependParentDirectories(command.args.folders);

  for (const folder of folders) {
    try {
      await fsMkdir(port, folder);
    } catch (error) {
      console.debug(
        `Failed to create folder: ${folder} with error: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error"
        }`
      );
      failedMkdirs++;
    }
  }

  // TODO: errors must be checked as if a folder did already exist in the
  // first place this operation should not be considered as failed
  return { type: OperationResultType.status, status: failedMkdirs === 0 };
}

export async function executeRmdirsCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.rmdirs>
): Promise<OperationResult> {
  ok(command.args.folders);

  let failedRmdirs = 0;
  for (const folder of command.args.folders) {
    try {
      await fsRemove(port, folder);
    } catch (error) {
      console.debug(
        `Failed to delete folder: ${folder} with error: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error"
        }`
      );
      failedRmdirs++;
    }
  }

  // TODO: errors must be checked as if a folder did not exist in the
  // first place this operation should not be considered as failed
  return { type: OperationResultType.status, status: failedRmdirs === 0 };
}

/**
 * Execute a rmtree command on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeRmtreeRecursiveCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.rmtree>
): Promise<OperationResult> {
  ok(command.args.folders);

  let failedRmdirs = 0;
  for (const folder of command.args.folders) {
    try {
      await fsRemove(port, folder);
    } catch (error) {
      console.debug(
        `Failed to delete folder: ${folder} with error: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error"
        }`
      );
      failedRmdirs++;
    }
  }

  // TODO: errors must be checked as if a folder did not exist in the
  // first place this operation should not be considered as failed
  return { type: OperationResultType.status, status: failedRmdirs === 0 };
}

export async function executeRmFileOrDirectoryCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.rmFileOrDir>
): Promise<OperationResult> {
  ok(command.args.target);

  const recursive = command.args.recursive ?? false;

  try {
    const isDir = await fsIsDir(port, command.args.target);

    if (isDir) {
      if (recursive) {
        await fsRmdirRecursive(port, command.args.target);
      } else {
        await fsRmdir(port, command.args.target);
      }
    } else {
      await fsRemove(port, command.args.target);
    }
  } catch (error) {
    console.debug(error);

    return { type: OperationResultType.status, status: false };
  }

  return { type: OperationResultType.status, status: true };
}

export async function executeUploadFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.uploadFiles>,
  receiver?: (data: Buffer) => void
): Promise<OperationResult> {
  ok(command.args.files);
  ok(command.args.remote);
  const remote = sanitizeRemote(command.args.remote);
  let totalFilesCount = command.args.files.length;
  let currentFilePos = -1;
  let lastFilePos = -1;

  let failedUploads = 0;
  for (const file of command.args.files) {
    try {
      //if (command.args.localBaseDir)
      if (command.args.localBaseDir) {
        const destinations = standardizePath(
          command.args.localBaseDir,
          command.args.files
        );

        for (const dest of destinations) {
          const dirPath = dirname(dest[1]);
          const folders = prependParentDirectories([dirPath]);
          for (const folder of folders) {
            await fsMkdir(port, folder);
          }

          if (receiver) {
            currentFilePos = destinations.indexOf(dest) + 1;
            // TODO: add the progress callback
            await fsPut(port, dest[0], remote + dirPath + "/");
          } else {
            await fsPut(port, dest[0], remote + dirPath + "/");
          }
        }
      } else {
        if (receiver) {
          // TODO: add progress callback
          await fsPut(port, file, remote);
        } else {
          await fsPut(port, file, remote);
        }
      }

      // TODO: for later use in progress callback
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      totalFilesCount = -1;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      currentFilePos = -1;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      lastFilePos = -1;
    } catch (error) {
      console.debug(
        `Failed to upload file: ${file} with error: ${
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error"
        }`
      );
      failedUploads++;
    }
  }

  return { type: OperationResultType.status, status: failedUploads === 0 };
}

export async function executeDownloadFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.downloadFiles>,
  receiver?: (data: Buffer) => void
): Promise<OperationResult> {
  ok(command.args.files);
  ok(command.args.local);

  // TODO: for later use in progress callback
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, prefer-const
  let totalFilesCount = command.args.files.length;

  if (command.args.files.length > 1) {
    createFolderStructure(command.args.files, command.args.local);

    if (command.args.local.slice(-1) !== sep) {
      command.args.local += sep;
    }

    const folderFiles: Record<string, string[]> = {};

    // group files by folder
    for (const file of command.args.files) {
      const folderPath = file.substring(0, file.lastIndexOf("/"));

      // Initialize the folder path if it doesn't exist
      if (!folderFiles[folderPath]) {
        folderFiles[folderPath] = [];
      }

      // Append the file path to the appropriate folder
      folderFiles[folderPath].push(file);
    }

    let currentFilePos = 0;
    for (const item of Object.entries(folderFiles)) {
      const folderPath = item[0];
      const files = item[1];

      const target =
        join(command.args.local, folderPath.replace(/^[:/]+/, "")) + sep;

      if (receiver) {
        // TODO: add progress callback
        for (const file of files) {
          currentFilePos++;
          // add progress callback
          try {
            await fsGet(port, file, target + file);
          } catch (error) {
            console.debug(
              `Failed to download file: ${file} with error: ${
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                  ? error
                  : "Unknown error"
              }`
            );
            continue;
          }
        }
      } else {
        for (const file of files) {
          // TODO: for later use in progress callback
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          currentFilePos++;
          try {
            await fsGet(port, file, target + file);
          } catch (error) {
            console.debug(
              `Failed to download file: ${file} with error: ${
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                  ? error
                  : "Unknown error"
              }`
            );
            continue;
          }
        }
      }
    }
  } else {
    if (receiver) {
      // add progress callback
      await fsGet(port, command.args.files[0], command.args.local);
    } else {
      await fsGet(port, command.args.files[0], command.args.local);
    }
  }

  // TODO: also decide when status false
  return { type: OperationResultType.status, status: true };
}
