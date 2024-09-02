import { EventEmitter } from "events";
import { SerialPort } from "serialport";
import { PicoSerialEvents } from "./picoSerialEvents.js";
import { Queue } from "./queue.js";
import { enterRawRepl, readUntil, stopRunningStuff } from "./serialHelper.js";
import { CommandType, type Command } from "./command.js";
import {
  type OperationResult,
  OperationResultType,
} from "./operationResult.js";
import { executeAnyCommand } from "./commandExec.js";
import type { ProgressCallback } from "./progressCallback.js";

const BUFFER_CR = Buffer.from("\r");

/**
 * Singleton class for handling serial communication with a MicroPython device.
 *
 * It also includes a static method to get a list of available serial ports that
 * fit the filter of supported devices.
 */
export class PicoMpyCom extends EventEmitter {
  private static _instance: PicoMpyCom;

  private serialPort?: SerialPort;
  // start with true to block queue until the connection is setup
  private operationInProgress = true;
  private queue = new Queue<number>();
  private queueIdCounter = 0;
  private resetInProgress = false;
  /// if set to true, no new operation will be executed only the already enqueued ones
  private serialPortClosing = false;
  private followReset?: (data: Buffer) => void;
  private resetResolve?: (
    value: OperationResult | PromiseLike<OperationResult>
  ) => void;

  private constructor() {
    // TODO: maybe set option to auto capture rejections
    super();
  }

  /**
   * Get the singleton instance of the class or create
   * a new one if it doesn't exist.
   *
   * @returns The singleton instance of the class.
   */
  public static getInstance(): PicoMpyCom {
    if (!PicoMpyCom._instance) {
      PicoMpyCom._instance = new PicoMpyCom();
    }

    return PicoMpyCom._instance;
  }

  /**
   * Returns a list of available serial ports that fit the given filter of supported devices.
   */
  public static async getSerialPorts(): Promise<string[]> {
    const ports = await SerialPort.list();

    // Raspberry Pi VID and Pico MicroPython CDC PID
    // TODO: maybe also return fiendly name
    return ports
      .filter(port => port.vendorId === "2E8A" && port.productId === "0005")
      .map(port => port.path);
  }

  /**
   * Opens a serial port connection to the given port.
   * @param port The port to connect to.
   */
  public async openSerialPort(port: string): Promise<void> {
    if (this.serialPort?.path === port) {
      return;
    }

    if (this.serialPort) {
      await this.closeSerialPort();
    }

    this.serialPort = new SerialPort({
      path: port,
      baudRate: 115200,
      autoOpen: true,
      lock: true,
    });

    // TODO: make sure after disconnect these don't exist multiple times if a
    // new connection is established

    // instead of returning the result we trigger an event if the ports opens successfully
    this.serialPort.on("open", this.onPortOpened.bind(this));

    this.serialPort.on("error", error => {
      this.emit(PicoSerialEvents.portError, error);
    });

    this.serialPort.on("close", () => {
      // TODO: move out of PicoMpyCom and into a separate file as it's hardware specific
      if (this.resetInProgress) {
        const onRelayInput = (data: Buffer): void => {
          if (data.length > 0) {
            this.serialPort?.write(Buffer.concat([data, BUFFER_CR]), err => {
              if (err) {
                this.emit(PicoSerialEvents.relayInputError, err);
              }
            });
          }
        };
        const onReadable = (): void => {
          if (!this.serialPort) {
            return;
          }
          const onInter = (): void => {
            if (this.serialPort) {
              stopRunningStuff(this.serialPort);
            }
          };
          this.once(PicoSerialEvents.interrupt, onInter);
          readUntil(this.serialPort, 2, "\n>>> ", null, this.followReset)
            .catch(() => {
              // Do nothing
            })
            .finally(() => {
              this.resetInProgress = false;
              this.followReset = undefined;
              this.off(PicoSerialEvents.relayInput, onRelayInput);
              this.off(PicoSerialEvents.interrupt, onInter);
              this.resolveReset();
              this.onPortOpened();
              this.executeNextOperation();
            });
        };

        let retries = 0;

        const reopening = (): void => {
          this.serialPort?.open((error?: Error | null) => {
            if (error) {
              if (retries++ > 40) {
                this.resetInProgress = false;
                this.resolveReset();
                void this.closeSerialPort();

                return;
              }

              // wait 100ms and try again
              setTimeout(reopening, 50);
            } else {
              this.serialPort?.once("readable", onReadable);
              if (this.followReset && this.serialPort) {
                this.on(PicoSerialEvents.relayInput, onRelayInput);
              }

              // only disable now as previous it would be to early and open would trigger
              this.resetInProgress = false;
            }
          });
        };
        // wait 200ms and reconnect
        setTimeout(reopening, 400);
      } else {
        this.emit(PicoSerialEvents.portClosed);
      }
    });
  }

  private resolveReset(): void {
    if (this.resetResolve) {
      this.resetResolve({
        type: OperationResultType.commandResult,
        result: true,
      });
      this.resetResolve = undefined;
    }
  }

  private onPortOpened(): void {
    // TODO: reset the resetInProgress flag if reconnect was not successfull for
    // some time
    if (!this.serialPort || this.resetInProgress) {
      return;
    }

    this.emit(PicoSerialEvents.portOpened);

    // setup the port
    enterRawRepl(this.serialPort, false)
      .then(() => {
        // unlock queue
        this.operationInProgress = false;
        this.executeNextOperation();
      })
      .catch(error => {
        this.emit(PicoSerialEvents.portError, error);
        void this.closeSerialPort();
      });
  }

  /**
   * Closes the serial port connection.
   */
  public async closeSerialPort(force = false): Promise<void> {
    if (this.serialPort) {
      if (!this.isPortDisconnected()) {
        if (!force) {
          this.serialPortClosing = true;
          // TODO: maybe use interruptExecution also
          // wait for the queue to finish
          await new Promise<void>(resolve => {
            const checkQueue = (): void => {
              if (!this.operationInProgress) {
                resolve();
              } else {
                setTimeout(checkQueue, 100);
              }
            };
            checkQueue();
          });
        } else {
          // interrupt still gives some kind of operations a chance terminate on their own terms
          this.interruptExecution();
          // TODO: maybe wait a short delay before closing
        }

        // close the port
        this.serialPort.close();
        // wait 0.5 seconds for the port to close and listeners to be notified
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // TODO: not sure if this is necessary as it would cause some overhead on clients
      // remove all listeners
      //this.serialPort.removeAllListeners();
      // reset state
      this.serialPort = undefined;
      this.operationInProgress = true;
      this.serialPortClosing = false;
      this.resetInProgress = false;
      this.followReset = undefined;
      this.resetResolve = undefined;
    }
  }

  // TODO: maybe move callbacks into Commands
  /**
   * The main method for enqueueing operations to be executed in the queue.
   * Possible long waiting time for Promise resolution.
   *
   * @param command The command to execute.
   * @param receiver The receiver function for the command response.
   * @returns The result of the operation.
   */
  private async enqueueCommandOperation(
    command: Command,
    receiver?: (data: Buffer) => void,
    readyStateCb?: (open: boolean) => void,
    pythonInterpreterPath?: string,
    progressCallback?: ProgressCallback
  ): Promise<OperationResult> {
    if (!this.serialPort || this.serialPortClosing) {
      //throw new Error("Serial port not open");
      return { type: OperationResultType.none };
    }
    // reserve an operation id
    const operationId = this.queueIdCounter++;

    return new Promise(resolve => {
      const processOperation = (id: number): void => {
        void (async (id: number): Promise<void> => {
          if (id !== operationId) {
            return;
          }

          // remove the listener
          this.off(PicoSerialEvents.startOperation, processOperation);
          if (!this.serialPort) {
            resolve({ type: OperationResultType.none });

            return;
          }

          // set this flag for operations that close the port
          if (command.type === CommandType.hardReset) {
            this.resetInProgress = true;
            this.followReset = receiver;
            this.resetResolve = resolve;
          }

          readyStateCb?.(true);

          // execute the command
          const result = await executeAnyCommand(
            this.serialPort,
            this,
            command,
            receiver,
            pythonInterpreterPath,
            progressCallback
          );

          if (command.type !== CommandType.hardReset) {
            // continue processing of the queue
            this.executeNextOperation();
            // !!! IMPORTANT !!! !!! IMPORTANT !!! !!! IMPORTANT !!!
            // BELOW THIS LINE NOT ACCESS TO THE SERIAL PORT IS ALLOWED
            // AND ACCOUNTED FOR BY THE QUEUEING SYSTEM

            // space for enqueueing follow up operations and resolve
            // after they are done

            resolve(result);
          }
        })(id);
      };

      this.on(PicoSerialEvents.startOperation, processOperation);

      this.queue.enqueue(operationId);

      if (!this.operationInProgress) {
        this.executeNextOperation();
      }
    });
  }

  /**
   * Executes the next operation in the queue if there is one.
   *
   * @returns The result of the operation.
   */
  private executeNextOperation(): void {
    const operation = this.queue.dequeue();
    if (operation === undefined) {
      this.operationInProgress = false;

      return;
    }

    // acquire the lock
    this.operationInProgress = true;

    this.emit(PicoSerialEvents.startOperation, operation);
  }

  /**
   * Checks if the serial port is disconnected.
   *
   * @returns True if the serial port is disconnected, false otherwise.
   */
  public isPortDisconnected(): boolean {
    return (
      !this.serialPort ||
      this.serialPort.closed ||
      this.serialPort.destroyed ||
      this.serialPort.errored !== null ||
      !this.serialPort.isOpen
    );
  }

  // TODO: make enqueueOperation public and extract the following methods
  // simplified action helpers
  public async helloWorld(
    receiver?: (data: Buffer) => void
  ): Promise<OperationResult> {
    // check serial connection before allowing to proceed with enqueueing
    // TODO: verify these are the correct check to determin the undesired state
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.command,
        args: { command: "print('Hello, World from the MicroPython board!')" },
      },
      receiver
    );
  }

  /**
   * List the contents of a directory on the MicroPython board.
   *
   * @param remotePath The path on the board to list the contents of.
   * @returns The result of the operation.
   */
  public async listContents(remotePath: string): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.listContents,
      args: { target: remotePath },
    });
  }

  /**
   * List the contents of a directory on the MicroPython board recursively.
   *
   * @param remotePath The path on the board to list the contents of.
   * @returns The result of the operation.
   */
  public async listContentsRecursive(
    remotePath: string
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.listContentsRecursive,
      args: { target: remotePath },
    });
  }

  /**
   * Run a command on the MicroPython board.
   *
   * @param command The command to execute.
   * @param receiver The receiver function for the command response.
   * @returns The result of the operation.
   */
  public async runCommand(
    command: string,
    receiver?: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.command,
        args: { command },
      },
      receiver
    );
  }

  /**
   * Execute a command on the MicroPython board.
   * This also support executing expressions and
   * redirecting follow up user input to the board.
   *
   * Be aware that follow up user input is
   * echoed back by the board.
   *
   * @param command The initial command to execute.
   * @param readyStateCb This callback get called once by the
   * queue system when the port is ready to receive additional user data.
   * If this triggers, user input can be fired as relayInput events.
   * Those events will be relayed to the board.
   * @param receiver A callback to receive the data from the board.
   * @param pythonInterpreterPath A path to a local python interpreter
   * for wrapping expressions. Can speed up execution of expressions.
   * @returns
   */
  public async runFriendlyCommand(
    command: string,
    readyStateCb: (open: boolean) => void,
    receiver: (data: Buffer) => void,
    pythonInterpreterPath?: string
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.expression,
        args: { code: command },
      },
      receiver,
      readyStateCb,
      pythonInterpreterPath
    );
  }

  /**
   * Inputs after reboot are relayed to the board after
   * the first time follow is called.
   *
   * @param follow The callback to receive the data from the board.
   * @returns The result of the operation.
   */
  public async hardReset(
    readyStateCb?: (open: boolean) => void,
    follow?: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.hardReset,
        args: {},
      },
      follow
    );
  }

  /**
   * Download files from the MicroPython board.
   *
   * @param files Download files from the board.
   * @param target Target directory on the local machine. If file count is 1,
   * the target can be a file path. If you want a single file to be downloaded into
   * the target folder, make sure it exists before downloading, otherwise it
   * will be treated as a target file path.
   * @param progressCallback The callback to receive the progress of the operation.
   * @returns The result of the operation.
   */
  public async downloadFiles(
    files: string[],
    target: string,
    progressCallback?: ProgressCallback
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.downloadFiles,
        args: { files, local: target },
      },
      undefined,
      undefined,
      undefined,
      progressCallback
    );
  }

  // TODO: move into it's own command to reduce queueing overhead
  /**
   * Download all files from the board into a project folder.
   *
   * @param projectRoot The folder where to download the project into.
   * @param remoteRoot The root folder on the board to download from.
   * If kept empty, the root of the board is used.
   * @param fileTypes File types to download (e.g. [".py", ".json"]).
   * If empty, all file types are downloaded.
   * @param ignoredItems Items to ignore during download.
   * Ignore items are relative the project folder paths to ignore
   * (can directly exclude a certain file or a folder).
   * (TODO: at the moment they need to be relative to / on the board no matter if remoteRoot is set)
   * or **\/item to ignore all items with that name.
   * @param progressCallback The callback to receive the progress of the operation.
   * @returns The result of the operation.
   */
  public async downloadProject(
    projectRoot: string,
    remoteRoot?: string,
    fileTypes?: string[],
    ignoredItems?: string[],
    progressCallback?: ProgressCallback
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.downloadProject,
        args: { projectRoot, remoteRoot, fileTypes, ignoredItems },
      },
      undefined,
      undefined,
      undefined,
      progressCallback
    );
  }

  // TODO: progress callback, calculate files and chunks per file before start if progress callback
  /**
   * Upload files to the MicroPython board.
   *
   * @param files Files to upload.
   * @param target Target directory on the board.
   * @param localBaseDir Local base directory for the files.
   * It will be used for relative placement of the files on the board
   * relative to the target. Used to keep the directory structure.
   * @param progressCallback The callback to receive the progress of the operation.
   * @returns The result of the operation.
   */
  public async uploadFiles(
    files: string[],
    target: string,
    localBaseDir?: string,
    progressCallback?: ProgressCallback
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.uploadFiles,
        args: { files, remote: target, localBaseDir },
      },
      undefined,
      undefined,
      undefined,
      progressCallback
    );
  }

  /**
   * Run a local file on the MicroPython board.
   *
   * @param file The local path to the file to run.
   * @param readyStateCb This callback get called once by the
   * queue system when the port is ready to receive additional user data.
   * @param follow The callback to receive the data from the board.
   * @returns The result of the operation.
   */
  public async runFile(
    file: string,
    readyStateCb: (open: boolean) => void,
    follow: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.runFile,
        args: { files: [file] },
      },
      follow,
      readyStateCb
    );
  }

  /**
   * Get the current RTC time of the MicroPython board.
   *
   * @returns The result of the operation.
   */
  public async getRtcTime(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.getRtcTime,
      args: {},
    });
  }

  /**
   * Synchronize the RTC time of the MicroPython board with the current system time.
   *
   * @returns The result of the operation.
   */
  public async syncRtcTime(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.syncRtc,
      args: {},
    });
  }

  /**
   * Deletes a folder on the board (recursive).
   *
   * @param folder The folder to delete.
   * @returns The result of the operation.
   */
  public async deleteFolderRecursive(folder: string): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.rmtree,
      args: { folders: [folder] },
    });
  }

  // TODO: document wildcards
  /**
   * Upload a project to the MicroPython board.
   *
   * @param projectFolder The path to the project folder to upload.
   * @param fileTypes File types to upload (e.g. ["py", "json"]).
   * Empty array uploads all files.
   * @param ignoredItems Items to ignore during upload.
   * Ignore items are relative the project folder paths to ignore
   * (can directly exclude a certain file or a folder)
   * or **\/item to ignore all items with that name.
   * @param progressCallback The callback to receive the progress of the operation.
   * @returns The result of the operation.
   */
  public async uploadProject(
    projectFolder: string,
    fileTypes: string[],
    ignoredItems: string[],
    progressCallback?: ProgressCallback
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.uploadProject,
        args: { projectFolder, fileTypes, ignoredItems },
      },
      undefined,
      undefined,
      undefined,
      progressCallback
    );
  }

  /**
   * Retrieve tab completions for a given code snippet.
   *
   * @param code The code snippet to retrieve tab completions for.
   * @returns The result of the operation.
   */
  public async retrieveTabCompletion(code: string): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.tabComplete,
      args: { code },
    });
  }

  /**
   * Get detailed information about a file or folder on the board.
   *
   * @param item The path to the file or folder to get information about.
   * @returns The result of the operation.
   */
  public async getItemStat(item: string): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.getItemStat,
      args: { item },
    });
  }

  /**
   * Soft reset the MicroPython board and cancel all auto-start scripts run after soft reset.
   *
   * @returns The result of the operation.
   */
  public async softReset(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.softReset,
      args: {},
    });
  }

  /**
   * Interrupts the execution of most kinds of operations if currently in progress.
   */
  public interruptExecution(): void {
    // don't mess with hard resets
    if (this.isPortDisconnected() || this.resetInProgress) {
      return;
    }

    // hope it takes effect
    this.emit(PicoSerialEvents.interrupt);
  }

  /**
   * Deletes a list of files on the board.
   *
   * @param files The list of files to delete.
   * @returns The result of the operation.
   */
  public async deleteFiles(files: string[]): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.deleteFiles,
      args: { files },
    });
  }

  /**
   * Creates a list of folders on the board.
   *
   * @param folders A list of folders to create.
   * @returns The result of the operation.
   */
  public async createFolders(folders: string[]): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.mkdirs,
      args: { folders },
    });
  }

  /**
   * Deletes a list of folders on the board.
   *
   * (the rmdir command does also allow to delete files
   * but is not intended for that, use the
   * rmFileOrDirectory command instead)
   *
   * @param folders The list of folders to delete.
   * @returns The result of the operation.
   */
  public async deleteFolders(folders: string[]): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.rmdirs,
      args: { folders },
    });
  }

  /**
   * Deletes a file or folder on the board (recursive).
   *
   * @param path The path to the file or folder to delete (without ':' prefix).
   * @param recursive If the delete should be recursive.
   * @returns
   */
  public async deleteFileOrFolder(
    target: string,
    recursive?: boolean
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.rmFileOrDir,
      args: { target, recursive },
    });
  }

  /**
   * Renames a file or folder on the board.
   *
   * @param item The current path of the item to rename.
   * @param target Should be in same dir as the old path (item).
   * @returns {OperationResult} OpResultStatus or OpResultNone
   */
  public async renameItem(
    item: string,
    target: string
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.rename,
      args: { item, target },
    });
  }

  /**
   * Performs a soft-reset and listens to the output of the board
   * and relays additional input to the board.
   *
   * @param readyStateCb This callback get called once by the
   * queue system when the port is ready to receive additional user data.
   * (I could take short moment after that for the content really to be relayed.)
   * @param follow The callback to receive the data from the board.
   * @returns The result of the operation.
   */
  public async sendCtrlD(
    readyStateCb: (open: boolean) => void,
    follow: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      { type: CommandType.ctrlD, args: {} },
      follow,
      readyStateCb
    );
  }

  // doesn't work on the pico
  /**
   * Factory reset the filesystem on the MicroPython board.
   *
   * Resetting the filesystem deletes all files on the internal storage (not the SD card),
   * and restores the files boot.py and main.py back to their original state
   * after the next reset.
   *
   * @returns The result of the operation.
   *
  public async factoryResetFileSystem(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.factoryResetFilesystem,
      args: {},
    });
  }*/
}
