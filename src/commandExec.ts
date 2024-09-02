import type { EventEmitter } from "events";
import type { SerialPort } from "serialport";
import {
  CHUNK_SIZE,
  enterRawRepl,
  evaluteExpression,
  executeCommand,
  exitRawRepl,
  fsCalcFilesHashes,
  fsGet,
  fsIsDir,
  fsListContents,
  fsListContentsRecursive,
  fsMkdir,
  fsPut,
  fsRemove,
  fsRename,
  fsRmdir,
  fsRmdirRecursive,
  fsStat,
  getRtcTime,
  hardReset,
  interactiveCtrlD,
  retrieveTabCompletion,
  runFile,
  stopRunningStuff,
  syncRtc,
} from "./serialHelper.js";
import { type Command, CommandType } from "./command.js";
import {
  type OperationResult,
  OperationResultType,
} from "./operationResult.js";
import { ok } from "assert";
import {
  createFolderStructure,
  getHashFromResponses,
  hasFile,
  prependParentDirectories,
  sanitizeRemote,
  standardizePath,
} from "./packetProcessing.js";
import { basename, dirname, extname, join, sep } from "path";
import { join as joinPosix } from "path/posix";
import {
  groundFolderPath,
  ignoreHelper,
  sanitizePath,
  scanFolder,
} from "./scanAndHash.js";
import {
  calculateTotalChunksLocal,
  calculateTotalChunksRemote,
  type ProgressCallback,
} from "./progressCallback.js";
import { PicoSerialEvents } from "./picoSerialEvents.js";
import { stat } from "fs/promises";

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
  pythonInterpreterPath?: string,
  progressCallback?: ProgressCallback
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
      ok(receiver, "Receiver must be provided for expression evaluation");

      return executeExpressionCommand(
        port,
        emitter,
        command as Command<CommandType.expression>,
        receiver,
        pythonInterpreterPath
      );

    case CommandType.listContents:
      return executeListContentsCommand(
        port,
        emitter,
        command as Command<CommandType.listContents>
      );

    case CommandType.listContentsRecursive:
      return executeListContentsRecursiveCommand(
        port,
        emitter,
        command as Command<CommandType.listContentsRecursive>
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

    case CommandType.uploadFiles:
      return executeUploadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.uploadFiles>,
        progressCallback
      );

    case CommandType.downloadFiles:
      return executeDownloadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.downloadFiles>,
        progressCallback
      );

    case CommandType.downloadProject:
      return executeDownloadProjectCommand(
        port,
        emitter,
        command as Command<CommandType.downloadProject>,
        progressCallback
      );

    case CommandType.getRtcTime:
      return executeGetRtcTimeCommand(port, emitter);

    case CommandType.syncRtc:
      return executeSyncRtcTimeCommand(port, emitter);

    case CommandType.uploadProject:
      return executeUploadProjectCommand(
        port,
        emitter,
        command as Command<CommandType.uploadProject>,
        progressCallback
      );

    case CommandType.getItemStat:
      return executeGetItemStatCommand(
        port,
        command as Command<CommandType.getItemStat>,
        emitter
      );

    case CommandType.rename:
      return executeRenameCommand(
        port,
        command as Command<CommandType.rename>,
        emitter
      );

    case CommandType.runFile:
      ok(receiver, "Receiver must be provided for run file command");

      return executeRunFileCommand(
        port,
        emitter,
        command as Command<CommandType.runFile>,
        receiver
      );

    case CommandType.doubleCtrlC:
      return executeDoubleCtrlCCommand(port);

    case CommandType.tabComplete:
      return executeTabCompleteCommand(
        port,
        command as Command<CommandType.tabComplete>
      );

    case CommandType.softReset:
      return executeSoftResetCommand(port);

    case CommandType.ctrlD:
      ok(receiver, "Receiver must be provided for ctrl-d command");

      return executeCtrlDCommand(port, emitter, receiver);

    //case CommandType.factoryResetFilesystem:
    //  return executeFactoryResetFilesystemCommand(port);
    case CommandType.hardReset:
      return executeHardResetCommand(port);

    default:
      // "Unknown command type"
      return { type: OperationResultType.none };
  }
}

/**
 *
 *
 * @param port
 * @returns
 */
export function executeHardResetCommand(port: SerialPort): OperationResult {
  try {
    hardReset(port);

    return { type: OperationResultType.commandResult, result: true };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

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
    const result = await executeCommand(
      port,
      command.args.command,
      emitter,
      receiver
    );

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

/**
 * Execute a command to evaluate an expression on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter The event emitter to listen for events.
 * @param command The command to execute.
 * @param receiver The function to receive the data as it comes in.
 * @param pythonInterpreterPath A path to a local python interpreter
 * for wrapping expressions. Can speed up execution of expressions.
 * @returns The result of the operation.
 */
export async function executeExpressionCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.expression>,
  receiver: (data: Buffer) => void,
  pythonInterpreterPath?: string
): Promise<OperationResult> {
  try {
    const error = await evaluteExpression(
      port,
      command.args.code,
      emitter,
      receiver,
      pythonInterpreterPath
    );

    if (error) {
      receiver(Buffer.from(error));
    }

    return { type: OperationResultType.commandResult, result: error === null };
  } catch {
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
  // TODO: possibility to remove silent fail and maybe check if directory not
  // exists or is a file
  const result = await fsListContents(port, emitter, command.args.target, true);

  return { type: OperationResultType.listContents, contents: result };
}

/**
 * Operation to list the contents of a directory on the board recursively.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The contents of the directory and its subdirectories and their subdirectories and so on.
 */
export async function executeListContentsRecursiveCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.listContentsRecursive>
): Promise<OperationResult> {
  ok(command.args.target);
  const result = await fsListContentsRecursive(
    port,
    emitter,
    command.args.target
  );

  return { type: OperationResultType.listContents, contents: result };
}

/**
 * Delete files on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeDeleteFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.deleteFiles>
): Promise<OperationResult> {
  ok(command.args.files);

  let failedDeletions = 0;
  for (const file of command.args.files) {
    try {
      await fsRemove(port, file, emitter);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "Unknown error";

      // if the file does not exist, it is not considered a failed deletion
      if (!message.includes("OSError: [Errno 2] ENOENT")) {
        failedDeletions++;
      } else if (message.toLowerCase().includes("interrupted")) {
        // don't try to delete more files if the operation was interrupted
        break;
      }
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: failedDeletions === 0,
  };
}

/**
 * Execute a command to create directories on the board.
 * Does not fail if the directory already exists.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
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
      await fsMkdir(port, folder, emitter);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "Unknown error";

      // if the folder does already exist, it is not considered a failed mkdir
      if (!message.includes("OSError: [Errno 17] EEXIST")) {
        failedMkdirs++;
      } else if (message.toLowerCase().includes("interrupted")) {
        // don't try to create more folders if the operation was interrupted
        break;
      }
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: failedMkdirs === 0,
  };
}

/**
 * Execute a command to delete directories on the board.
 *
 * (the rmdir command does also allow to delete files but is not intended for that,
 * use the rmFileOrDirectory command instead)
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeRmdirsCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.rmdirs>
): Promise<OperationResult> {
  ok(command.args.folders);

  let failedRmdirs = 0;
  for (const folder of command.args.folders) {
    try {
      await fsRmdir(port, folder, emitter);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "Unknown error";

      // if the folder does not exist, it is not considered a failed rmdir
      if (!message.includes("OSError: [Errno 2] ENOENT")) {
        failedRmdirs++;
      } else if (message.toLowerCase().includes("interrupted")) {
        // don't try to delete more folders if the operation was interrupted
        break;
      }
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: failedRmdirs === 0,
  };
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
      await fsRmdirRecursive(port, folder, emitter);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === "string"
          ? error
          : "Unknown error";

      if (!message.includes("OSError: [Errno 2] ENOENT")) {
        failedRmdirs++;
      } else if (message.toLowerCase().includes("interrupted")) {
        // don't try to delete more folders if the operation was interrupted
        break;
      }
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: failedRmdirs === 0,
  };
}

/**
 * Execute a command to remove a file or directory on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeRmFileOrDirectoryCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.rmFileOrDir>
): Promise<OperationResult> {
  ok(command.args.target);

  const recursive = command.args.recursive ?? false;

  try {
    const isDir = await fsIsDir(port, command.args.target, emitter);

    if (isDir) {
      if (recursive) {
        await fsRmdirRecursive(port, command.args.target, emitter);
      } else {
        await fsRmdir(port, command.args.target, emitter);
      }
    } else {
      await fsRemove(port, command.args.target, emitter);
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Unknown error";

    if (!message.includes("OSError: [Errno 2] ENOENT")) {
      return { type: OperationResultType.commandResult, result: false };
    }
  }

  return { type: OperationResultType.commandResult, result: true };
}

/**
 * Execute a command to upload files to the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Unused.
 * @param command The command to execute.
 * @param receiver A function to receive the data as it comes in. (not supported by all commands)
 * @returns The result of the operation.
 */
export async function executeUploadFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.uploadFiles>,
  progressCallback?: ProgressCallback
): Promise<OperationResult> {
  ok(command.args.files);
  ok(command.args.remote);
  const remote = sanitizeRemote(command.args.remote);

  let interrupted = false;
  let failedUploads = 0;

  // does need its own interrupt handler compared to
  // the put calles it does to catch interrupts fired
  // between the put calls
  const onInterrupt = (): void => {
    interrupted = true;
  };
  emitter.once("interrupt", onInterrupt);

  //if (command.args.localBaseDir)
  if (command.args.localBaseDir) {
    const destinations = standardizePath(
      command.args.localBaseDir,
      command.args.files
    );

    const totalChunksCount = progressCallback
      ? await calculateTotalChunksLocal(
          destinations.map(d => d[0]),
          CHUNK_SIZE
        )
      : 0;
    let chunksTransfered = 0;

    for (const dest of destinations) {
      const dirPath = dirname(dest[1]);
      const folders = prependParentDirectories([dirPath]);

      if (interrupted) {
        break;
      }

      try {
        for (const folder of folders) {
          if (interrupted) {
            break;
          }

          try {
            await fsMkdir(port, folder, emitter, false);
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : typeof error === "string"
                ? error
                : "Unknown error";
            if (message.toLowerCase().includes("interrupted")) {
              // don't try to create more folders if the operation was interrupted
              interrupted = true;
              break;
            }
          }
        }
        // don't even attempt to upload the file if the operation was interrupted
        if (interrupted) {
          break;
        }

        if (progressCallback) {
          const ct = await fsPut(
            port,
            dest[0],
            remote + dirPath + "/",
            emitter,
            CHUNK_SIZE,
            totalChunksCount,
            chunksTransfered,
            progressCallback
          );
          if (ct) {
            chunksTransfered += ct;
          }
        } else {
          await fsPut(port, dest[0], remote + dirPath + "/", emitter);
        }

        if (interrupted) {
          break;
        }
      } catch (error) {
        failedUploads++;
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error";
        if (message.toLowerCase().includes("interrupted")) {
          // don't try to upload more files if the operation was interrupted
          interrupted = true;
          break;
        }
      }

      if (interrupted) {
        break;
      }
    }
  } else {
    const totalChunksCount = progressCallback
      ? await calculateTotalChunksLocal(command.args.files, CHUNK_SIZE)
      : 0;
    let chunksTransfered = 0;

    for (const file of command.args.files) {
      try {
        if (progressCallback) {
          const ct = await fsPut(
            port,
            file,
            remote,
            emitter,
            CHUNK_SIZE,
            totalChunksCount,
            chunksTransfered,
            progressCallback
          );

          if (ct) {
            chunksTransfered += ct;
          }
        } else {
          await fsPut(port, file, remote, emitter);
        }
      } catch (error) {
        // TODO: log error, maybe though event emitter
        failedUploads++;

        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : "Unknown error";

        if (message.toLowerCase().includes("interrupted")) {
          // don't try to upload more files if the operation was interrupted
          interrupted = true;
          break;
        }
      }

      if (interrupted) {
        break;
      }
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: failedUploads === 0 && !interrupted,
  };
}

/**
 * Execute a command to download files from the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Not used.
 * @param command The command to execute.
 * @param receiver A function to receive the data as it comes in. (WIP for this command)
 * @returns The result of the operation.
 */
export async function executeDownloadFilesCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.downloadFiles>,
  progressCallback?: ProgressCallback
): Promise<OperationResult> {
  ok(command.args.files);
  ok(command.args.local);

  let failedDownloads = 0;
  let interrupted = false;
  // does need its own interrupt handler compared to
  // the get calles it does to catch interrupts fired
  // between the get calls
  const onInterrupt = (): void => {
    interrupted = true;
  };
  emitter.once("interrupt", onInterrupt);

  if (command.args.files.length > 1) {
    createFolderStructure(
      command.args.files,
      command.args.local,
      command.args.remoteBaseDir
    );

    if (command.args.local.slice(-1) !== sep) {
      command.args.local += sep;
    }

    const folderFiles: Record<string, string[]> = {};

    if (interrupted) {
      return { type: OperationResultType.commandResult, result: false };
    }

    const totalChunksCount = progressCallback
      ? await calculateTotalChunksRemote(
          port,
          command.args.files,
          CHUNK_SIZE,
          emitter
        )
      : 0;
    let chunksTransfered = 0;

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

    for (const item of Object.entries(folderFiles)) {
      if (interrupted) {
        break;
      }

      const folderPath = item[0];
      const files = item[1];

      const target =
        join(
          command.args.local,
          // TODO: run twice (also above in createFolderStructure)
          groundFolderPath(
            folderPath.replace(/^[:/]+/, ""),
            command.args.remoteBaseDir
          )
        ) + sep;

      if (progressCallback) {
        for (const file of files) {
          try {
            const ct = await fsGet(
              port,
              file,
              join(target, basename(file)),
              emitter,
              CHUNK_SIZE,
              totalChunksCount,
              chunksTransfered,
              progressCallback
            );

            if (ct) {
              chunksTransfered += ct;
            }
          } catch (error) {
            failedDownloads++;
            const message =
              error instanceof Error
                ? error.message
                : typeof error === "string"
                ? error
                : "Unknown error";
            if (message.toLowerCase().includes("interrupted")) {
              interrupted = true;
              break;
            }

            // TODO: log error
            continue;
          }
        }
      } else {
        for (const file of files) {
          try {
            await fsGet(port, file, join(target, basename(file)), emitter);
          } catch (error) {
            failedDownloads++;
            const message =
              error instanceof Error
                ? error.message
                : typeof error === "string"
                ? error
                : "Unknown error";
            if (message.toLowerCase().includes("interrupted")) {
              interrupted = true;
              break;
            }

            // TODO: log error
            continue;
          }

          if (interrupted) {
            break;
          }
        }
      }
    }
  } else {
    try {
      // support for using local as parameter to directly specify a target file
      // but also have the option to specify a target directory
      let target = command.args.local;
      try {
        const localStat = await stat(command.args.local);
        if (localStat.isDirectory()) {
          target = join(command.args.local, basename(command.args.files[0]));
        }
      } catch {
        // no problem, just treat target as a file
      }

      if (progressCallback) {
        const totalChunksCount = await calculateTotalChunksRemote(
          port,
          command.args.files,
          CHUNK_SIZE,
          emitter
        );

        await fsGet(
          port,
          command.args.files[0],
          target,
          emitter,
          CHUNK_SIZE,
          totalChunksCount,
          0,
          progressCallback
        );
      } else {
        await fsGet(port, command.args.files[0], target, emitter);
      }
    } catch {
      failedDownloads++;

      return { type: OperationResultType.commandResult, result: false };
    }
  }

  return {
    type: OperationResultType.commandResult,
    result: !interrupted || failedDownloads === command.args.files.length,
  };
}

/**
 * Executes a download project command used to only download files that have changed
 * or are not present in the local project folder.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter The event emitter to listen for events.
 * @param command The command to execute.
 * @param progressCallback A function to call to report progress.
 * @returns The result of the operation.
 */
export async function executeDownloadProjectCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.downloadProject>,
  progressCallback?: ProgressCallback
): Promise<OperationResult> {
  ok(command.args.projectRoot);
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
  };
  emitter.once(PicoSerialEvents.interrupt, onInterrupt);

  const ignoredWildcardItems =
    command.args.ignoredItems?.filter(item => item.startsWith("**/")) ?? [];
  const ignoredItems =
    command.args.ignoredItems
      ?.filter(item => !item.startsWith("**/"))
      .map(item => sanitizePath(item)) ?? [];

  // ensure file types are in the format ".ext"
  const fileTypes =
    command.args.fileTypes?.map(ft => (ft.startsWith(".") ? ft : `.${ft}`)) ??
    [];
  const remoteRoot = command.args.remoteRoot ?? "/";

  try {
    const contents = (
      await fsListContentsRecursive(port, emitter, remoteRoot)
    ).filter(
      file =>
        !file.isDir &&
        (fileTypes.length === 0 || fileTypes.includes(extname(file.path))) &&
        ignoreHelper(ignoredWildcardItems, ignoredItems, file.path)
    );

    if (contents.length === 0) {
      emitter.off(PicoSerialEvents.interrupt, onInterrupt);

      // TODO: maybe result=false if no files there to download
      return { type: OperationResultType.commandResult, result: true };
    }

    if (interrupted) {
      throw new Error("Interrupted");
    }

    const remoteHashes = await fsCalcFilesHashes(
      port,
      contents.map(file => file.path),
      emitter
    );

    if (interrupted) {
      throw new Error("Interrupted");
    }

    // TODO: only parse a list of remote files and check if they exist localy
    // if true calc hash
    const localHashes = scanFolder({
      folderPath: command.args.projectRoot,
      // reduce processing time (maybe)
      fileTypes:
        fileTypes.length > 0
          ? fileTypes
          : contents.map(file => extname(file.path)),
      ignoredWildcardItems: ignoredWildcardItems,
      ignoredPaths: ignoredItems,
    });

    if (interrupted) {
      throw new Error("Interrupted");
    }

    const filePathsToDownload = contents
      .map(file => file.path)
      .filter(
        file =>
          !localHashes.has(file) ||
          localHashes.get(file) !== getHashFromResponses(remoteHashes, file)
      );

    emitter.off(PicoSerialEvents.interrupt, onInterrupt);
    if (filePathsToDownload.length === 0) {
      return { type: OperationResultType.commandResult, result: true };
    } else if (interrupted) {
      throw new Error("Interrupted");
    }

    return executeDownloadFilesCommand(
      port,
      emitter,
      {
        type: CommandType.downloadFiles,
        args: {
          files: filePathsToDownload,
          local:
            filePathsToDownload.length > 1
              ? command.args.projectRoot
              : joinPosix(command.args.projectRoot, filePathsToDownload[0]),
          remoteBaseDir: command.args.remoteRoot,
        },
      },
      progressCallback
    );
  } catch {
    emitter.off(PicoSerialEvents.interrupt, onInterrupt);

    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Run a local file on the board.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter Used for post execution-start user input relay.
 * @param command The command to execute.
 * @param receiver A function to receive the data as it comes in.
 * @returns The result of the operation.
 */
export async function executeRunFileCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.runFile>,
  receiver: (data: Buffer) => void
): Promise<OperationResult> {
  ok(command.args.files && command.args.files.length === 1);

  try {
    await runFile(port, command.args.files[0], emitter, receiver);

    return { type: OperationResultType.commandResult, result: true };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Execute a command to get the current time from the RTC on the board.
 *
 * @param port The serial port where the board is connected to.
 * @returns The result of the operation.
 */
export async function executeGetRtcTimeCommand(
  port: SerialPort,
  emitter: EventEmitter
): Promise<OperationResult> {
  try {
    const result = await getRtcTime(port, emitter);

    return { type: OperationResultType.getRtcTime, time: result };
  } catch {
    return { type: OperationResultType.none };
  }
}

/**
 * Execute a command to synchronize the RTC on the board with the current time on the host.
 *
 * @param port The serial port where the board is connected to.
 * @returns The result of the operation.
 */
export async function executeSyncRtcTimeCommand(
  port: SerialPort,
  emitter: EventEmitter
): Promise<OperationResult> {
  try {
    await syncRtc(port, emitter);

    return { type: OperationResultType.commandResult, result: true };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Execute a command to upload a project to the board.
 * A project upload is a upload of files within a folder recursively.
 * But with the difference that you have the option to ignore certain files/folder
 * and or to only upload certain file types.
 *
 * Additionally the files are hashed before uploading to avoid unnecessary uploads.
 *
 * @param port The serial port where the board is connected to.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeUploadProjectCommand(
  port: SerialPort,
  emitter: EventEmitter,
  command: Command<CommandType.uploadProject>,
  progressCallback?: ProgressCallback
): Promise<OperationResult> {
  // TODO: remove requirements for > 0 files count
  ok(command.args.projectFolder, "Project folder must be provided");
  ok(command.args.fileTypes, "File types must be provided");
  ok(command.args.ignoredItems, "Ignored items must be provided");

  // ensure file types are in the format ".ext"
  const fileTypes =
    command.args.fileTypes?.map(ft => (ft.startsWith(".") ? ft : `.${ft}`)) ??
    [];

  const localHashes = scanFolder({
    folderPath: command.args.projectFolder,
    fileTypes,
    ignoredWildcardItems: command.args.ignoredItems.filter(item =>
      item.startsWith("**/")
    ),
    ignoredPaths: command.args.ignoredItems.filter(
      item => !item.startsWith("**/")
    ),
  });

  try {
    const remoteHashes = await fsCalcFilesHashes(
      port,
      Array.from(localHashes.keys(), file =>
        // clear out any Windows style and duble slashes
        file.replaceAll("\\", "/").replace("//+/g", "/")
      ),
      emitter
    );

    const filesToUpload = [...localHashes.keys()]
      // TODO: find better solution maybe already translate the paths in localHashes
      // required for equals comparission with remote hashes, keep og for get from local
      .map(file => [file, file.replaceAll("\\", "/").replace("//+/g", "/")])
      .filter(
        file =>
          !hasFile(remoteHashes, file[1]) ||
          getHashFromResponses(remoteHashes, file[1]) !==
            localHashes.get(file[0])
      )
      .map(file => join(command.args.projectFolder, file[1]));

    if (filesToUpload.length === 0) {
      return { type: OperationResultType.commandResult, result: true };
    } else {
      return executeUploadFilesCommand(
        port,
        emitter,
        {
          type: CommandType.uploadFiles,
          args: {
            files: filesToUpload,
            // TODO: support selection of remote folder
            remote: ":",
            localBaseDir: command.args.projectFolder,
          },
        },
        progressCallback
      );
    }
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Execute a command to stop any running code on the board.
 *
 * @param port The serial port where the board is connected to.
 * @returns The result of the operation.
 */
export function executeDoubleCtrlCCommand(port: SerialPort): OperationResult {
  try {
    let errOccured = false;
    stopRunningStuff(port, () => {
      errOccured = true;
    });

    return { type: OperationResultType.commandResult, result: !errOccured };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

// TODO: also add the ability to get completions for file paths
/**
 * Execute a command to get tab completions for a given code snippet.
 *
 * @param port The serial port where the board is connected to.
 * @param command The command to execute.
 * @returns The result of the operation.
 */
export async function executeTabCompleteCommand(
  port: SerialPort,
  command: Command<CommandType.tabComplete>
): Promise<OperationResult> {
  ok(command.args.code !== undefined);
  if (command.args.code.length === 0) {
    return { type: OperationResultType.none };
  }

  try {
    const result = await retrieveTabCompletion(port, command.args.code);

    return {
      type: OperationResultType.tabComplete,
      isSimple: result[1],
      suggestions: result[0],
    };
  } catch {
    return { type: OperationResultType.none };
  }
}

/**
 * Executes getItemStat commands.
 *
 * @param port The serial port where the board is connected to.
 * @param command The command to execute.
 * @param emitter An event emitter to listen for interrupts.
 * @returns The result of the operation.
 */
export async function executeGetItemStatCommand(
  port: SerialPort,
  command: Command<CommandType.getItemStat>,
  emitter: EventEmitter
): Promise<OperationResult> {
  ok(command.args.item);

  try {
    const result = await fsStat(port, emitter, command.args.item);

    return { type: OperationResultType.getItemStat, stat: result ?? null };
  } catch {
    // TODO: maybe return type none
    return { type: OperationResultType.getItemStat, stat: null };
  }
}

/**
 * Executes rename commands.
 *
 * @param port The serial port where the board is connected to.
 * @param command The command to execute.
 * @param emitter An event emitter to listen for interrupts.
 * @returns The result of the operation.
 */
export async function executeRenameCommand(
  port: SerialPort,
  command: Command<CommandType.rename>,
  emitter: EventEmitter
): Promise<OperationResult> {
  ok(command.args.item);
  ok(command.args.target);

  try {
    await fsRename(port, command.args.item, command.args.target, emitter);

    return { type: OperationResultType.commandResult, result: true };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * This does a soft reset but cancels the boot and main.py scripts immediately.
 *
 * @param port The serial port where the board is connected to.
 * @returns The result of the operation.
 */
export async function executeSoftResetCommand(
  port: SerialPort
): Promise<OperationResult> {
  try {
    // or import sys; sys.exit() based on docs | but didn't work
    stopRunningStuff(port);
    await exitRawRepl(port);
    await enterRawRepl(port, true);
    // wait 0.1 seconds
    await new Promise(resolve => setTimeout(resolve, 100));

    return { type: OperationResultType.commandResult, result: true };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

/**
 * Executes a ctrl-d command.
 *
 * @param port The serial port where the board is connected to.
 * @param emitter An event emitter to listen for interrupts and to relay inputs.
 * @param receiver A callback to receive the data as it comes in.
 * @returns The result of the operation.
 */
export async function executeCtrlDCommand(
  port: SerialPort,
  emitter: EventEmitter,
  receiver: (data: Buffer) => void
): Promise<OperationResult> {
  try {
    const result = await interactiveCtrlD(port, emitter, receiver);

    return { type: OperationResultType.commandResult, result };
  } catch {
    return { type: OperationResultType.commandResult, result: false };
  }
}

// doesn't work on the pico
/*
export async function executeFactoryResetFilesystemCommand(
  port: SerialPort
): Promise<OperationResult> {
  try {
    await fsFactoryReset(port);

    return { type: OperationResultType.commandResult, result: true };
  } catch (error) {
    console.error(error);

    return { type: OperationResultType.commandResult, result: false };
  }
}
*/
