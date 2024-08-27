import { EventEmitter } from "events";
import { SerialPort } from "serialport";
import { PicoSerialEvents } from "./picoSerialEvents.js";
import { Queue } from "./queue.js";
import { enterRawRepl, readUntil } from "./serialHelper.js";
import { CommandType, type Command } from "./command.js";
import {
  type OperationResult,
  OperationResultType,
} from "./operationResult.js";
import { executeAnyCommand } from "./commandExec.js";

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
  private resetResolve?: (data: OperationResult) => void;

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
    if (this.serialPort) {
      await this.closeSerialPort();
    }

    this.serialPort = new SerialPort({
      path: port,
      baudRate: 115200,
      autoOpen: true,
      lock: true,
    });

    // instead of returning the result we trigger an event if the ports opens successfully
    this.serialPort.on("open", this.onPortOpened.bind(this));

    this.serialPort.on("error", error => {
      this.emit(PicoSerialEvents.portError, error);
    });

    this.serialPort.on("close", () => {
      if (this.resetInProgress) {
        this.resetInProgress = false;
        // wait 2 seconds and reconnect
        setTimeout(() => {
          console.debug("Reopening serial port after reset...");
          this.reopenSerialPort();
          if (this.resetResolve && !this.followReset) {
            this.resolveReset();
          }
        }, 2000);
      } else {
        this.emit(PicoSerialEvents.portClosed);
      }
    });

    /*this.serialPort.on("data", data => {
      console.log(data instanceof Buffer ? data.toString("utf-8") : data);
    });*/
  }

  private resolveReset(): void {
    if (this.resetResolve) {
      this.resetResolve({
        type: OperationResultType.commandResult,
        result: true,
      });
      this.resetResolve = undefined;
    }
    this.executeNextOperation();
  }

  private onPortOpened(): void {
    // TODO: reset the resetInProgress flag if reconnect was not successfull for
    // some time
    if (!this.serialPort || this.resetInProgress) {
      return;
    }

    this.emit(PicoSerialEvents.portOpened);

    // setup the port
    enterRawRepl(this.serialPort)
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
      if (!force) {
        this.serialPortClosing = true;
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
      }
      // close the port
      this.serialPort.close();
      // wait 0.5 seconds for the port to close and listeners to be notified
      await new Promise(resolve => setTimeout(resolve, 500));
      // remove all listeners
      this.serialPort.removeAllListeners();
      // reset state
      this.serialPort = undefined;
      this.operationInProgress = true;
      this.serialPortClosing = false;
    }
  }

  private reopenSerialPort(): void {
    if (!this.serialPort || this.serialPort.isOpen) {
      return;
    }

    if (this.followReset) {
      const onRelayInput = (data: Buffer): void => {
        this.serialPort?.write(data);
      };
      const onReadable = (): void => {
        readUntil(this.serialPort!, 5, "\n>>> ", null, this.followReset)
          // TODO: check if finally is executed after catch if catch was executed
          .catch(() => {
            this.resetInProgress = false;
            this.followReset = undefined;
            this.off(PicoSerialEvents.relayInput, onRelayInput);
            this.onPortOpened();
          })
          .finally(() => {
            // avoid retriggering if catch is executed
            if (this.followReset) {
              this.resetInProgress = false;
              this.followReset = undefined;
              this.off(PicoSerialEvents.relayInput, onRelayInput);
              this.onPortOpened();
            }
          });
      };
      this.serialPort.once("readable", onReadable);
      this.on(PicoSerialEvents.relayInput, onRelayInput);
    }

    this.serialPort.open();
  }

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
    pythonInterpreterPath?: string
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
          }

          readyStateCb?.(true);

          // execute the command
          const result = await executeAnyCommand(
            this.serialPort,
            this,
            command,
            receiver,
            pythonInterpreterPath
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

  private isPortDisconnected(): boolean {
    return (
      !this.serialPort || this.serialPort.closed || this.serialPort.destroyed
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
   * Execute a command on the MicroPython board.
   * This also support executing expressions and
   * redirecting folloup user input to the board.
   *
   * @param command The initial command to execute.
   * @param readyStateCb This callback get called once by the
   * queue system when the port is ready to receive additional user data.
   * If this triggers, user input can be fired as relayInput events.
   * Those events will be relayed to the board.
   * @param receiver A callback to receive the data from the board.
   * @returns
   */
  public async runFriendlyCommand(
    command: string,
    readyStateCb: (open: boolean) => void,
    receiver: (data: Buffer) => void,
    pythonInterpreterPath: string
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

  public async downloadFiles(
    files: string[],
    target: string,
    follow?: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.downloadFiles,
        args: { files, local: target },
      },
      follow
    );
  }

  // TODO: progress callback, calculate files and chunks per file before start if progress callback
  public async uploadFiles(
    files: string[],
    target: string,
    localBaseDir?: string,
    follow?: (data: Buffer) => void
  ): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation(
      {
        type: CommandType.uploadFiles,
        args: { files, remote: target, localBaseDir },
      },
      follow
    );
  }

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

  public async getRtcTime(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.getRtcTime,
      args: {},
    });
  }

  public async syncRtcTime(): Promise<OperationResult> {
    if (this.isPortDisconnected()) {
      return { type: OperationResultType.none };
    }

    return this.enqueueCommandOperation({
      type: CommandType.syncRtc,
      args: {},
    });
  }
}
