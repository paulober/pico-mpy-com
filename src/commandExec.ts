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
import { dirname, join, sep } from "path";
import { scanFolder } from "./scanAndHash.js";
import {
  calculateTotalChunksLocal,
  calculateTotalChunksRemote,
  type ProgressCallback,
} from "./progressCallback.js";

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
      ok(
        pythonInterpreterPath,
        "Python interpreter path must be provided for expression evaluation"
      );
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

    // TODO: implementation not finished
    case CommandType.uploadFiles:
      return executeUploadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.uploadFiles>,
        progressCallback
      );

    // TODO: implementation not finished
    case CommandType.downloadFiles:
      return executeDownloadFilesCommand(
        port,
        emitter,
        command as Command<CommandType.downloadFiles>,
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

    default:
      // "Unknown command type"
      return { type: OperationResultType.none };
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
 * @param pythonInterpreterPath The path to a local Python interpreter use for
 * expression wrapping.
 * @returns The result of the operation.
 */
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

  let interrupted = false;
  // does need its own interrupt handler compared to
  // the get calles it does to catch interrupts fired
  // between the get calls
  const onInterrupt = (): void => {
    interrupted = true;
  };
  emitter.once("interrupt", onInterrupt);

  if (command.args.files.length > 1) {
    createFolderStructure(command.args.files, command.args.local);

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
        join(command.args.local, folderPath.replace(/^[:/]+/, "")) + sep;

      if (progressCallback) {
        // TODO: add progress callback
        for (const file of files) {
          // add progress callback
          try {
            const ct = await fsGet(
              port,
              file,
              target + file,
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
            await fsGet(port, file, target + file, emitter);
          } catch (error) {
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
      if (progressCallback) {
        const totalChunksCount = await calculateTotalChunksRemote(
          port,
          command.args.files,
          CHUNK_SIZE,
          emitter
        );

        // add progress callback
        await fsGet(
          port,
          command.args.files[0],
          command.args.local,
          emitter,
          CHUNK_SIZE,
          totalChunksCount,
          0,
          progressCallback
        );
      } else {
        await fsGet(port, command.args.files[0], command.args.local, emitter);
      }
    } catch {
      return { type: OperationResultType.commandResult, result: false };
    }
  }

  // TODO: also decide when status false
  return { type: OperationResultType.commandResult, result: !interrupted };
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

  const localHashes = scanFolder({
    folderPath: command.args.projectFolder,
    fileTypes: command.args.fileTypes,
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
  ok(command.args.code);

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

    // TODO: or return .status or remove .status type
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
