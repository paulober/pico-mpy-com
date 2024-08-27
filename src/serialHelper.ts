/* eslint-disable max-len */
import { ok } from "assert";
import type { SerialPort } from "serialport";
import type FileData from "./fileData.js";
import {
  dateToRp2Datetime,
  type HashResponse,
  parseHashJson,
  parseListContentsPacket,
  parseStatJson,
  rp2DatetimeToDate,
  wrapExpressionWithPrint,
} from "./packetProcessing.js";
import { type FileHandle, open as hostFsOpen } from "fs/promises";
import { injectedImportHookCode } from "./injectedImportHook.js";
import type { EventEmitter } from "events";
import { PicoSerialEvents } from "./picoSerialEvents.js";
import {
  encodeStringToEscapedBin,
  writeEncodedBufferToFile,
} from "./escapeCoder.js";
import { basename } from "path";

// NOTE! it's encouraged to __pe_ as prefix for variables and functions defined
// in the MicroPython REPL's global scope

let useRawPasteMode = true;

// Pre-allocate buffers for comparison or sending
const BUFFER_RAW_PASTE_STATUS = Buffer.from("\x05A\x01");
const BUFFER_R00 = Buffer.from("R\x00");
const BUFFER_R01 = Buffer.from("R\x01");
const BUFFER_01 = Buffer.from("\x01");
const BUFFER_04 = Buffer.from("\x04");

function ensureBuffer(data: Buffer | string | null): Buffer {
  if (data === null) {
    return Buffer.from("");
  } else if (typeof data === "string") {
    return Buffer.from(data, "utf-8");
  } else {
    return data;
  }
}

/**
 * Reads data from the serial port until the given suffix is found.
 *
 * @param port The serial port to read from.
 * @param minBytesCount The minimum number of bytes to read before checking for the suffix.
 * @param suffix The suffix to look for in the data.
 * @param timeout The timeout in seconds to wait for the suffix.
 * @param receiver If provided, the function will be called with the
 * data received from the serial port when it arrives. And it will only return
 * the last byte read.
 * @throws Timeout error if the timeout is reached.
 * @returns The data read from the serial port.
 */
export async function readUntil(
  port: SerialPort,
  minBytesCount: number,
  suffix: string | Buffer,
  timeout: number | null = 10,
  receiver?: (data: Buffer) => void
): Promise<Buffer | undefined> {
  // TODO: remove logging commands
  ok(receiver === undefined || suffix.length === 1);

  const exprectedSuffix =
    suffix instanceof Buffer ? suffix : Buffer.from(suffix, "utf-8");
  let timeoutCount = 0;
  const maxTimeoutCount = timeout === null ? 0 : timeout * 100;

  let buffer = ensureBuffer(port.read(minBytesCount) as Buffer | string | null);

  if (receiver) {
    receiver(buffer);
  }
  while (true) {
    if (buffer.subarray(-exprectedSuffix.length).equals(exprectedSuffix)) {
      break;
    } else if (port.readable && port.readableLength > 0) {
      const newData = ensureBuffer(port.read(1) as Buffer | string | null);
      // TODO: maybe also not relay the data if it is the suffix
      if (receiver && !newData.equals(BUFFER_04)) {
        receiver(newData);
        // reduce memory usage by reassigning buffer
        // instead of concatenating as the data has
        // already been relayed to the receiver
        buffer = newData;
      } else {
        buffer = Buffer.concat([buffer, newData]);
      }
      //process.stdout.write(newData.toString("utf-8"));

      // reset timeout
      timeoutCount = 0;
    } else {
      timeoutCount++;
      if (timeout !== null && timeoutCount >= maxTimeoutCount) {
        break;
      }

      // wait for data to be available
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  return buffer;
}

/**
 * Stops any running program on the connected board.
 *
 * @param port The serial port to write to.
 * @param errorCb The callback to call if an error occurs. If not
 * provided, an error will be thrown instead.
 * @throws Error if the write operation fails and no error callback is provided.
 */
export function stopRunningStuff(
  port: SerialPort,
  errorCb?: (err: Error | null | undefined) => void
): void {
  // send CTRL-C twice to stop any running program
  port.write(
    "\r\x03\x03",
    errorCb ??
      ((err: Error | null | undefined): void => {
        if (err) {
          throw new Error("Error stopping running stuff");
        }
      })
  );
}

/**
 * Puts the MicroPython REPL on the connected board into raw mode.
 *
 * @param port The serial port to write to.
 * @throws Error if the write operation fails.
 */
export async function enterRawRepl(
  port: SerialPort,
  softReset = true
): Promise<void> {
  // TODO: remove debug logs
  const errCb = (err: Error | null | undefined): void => {
    if (err) {
      throw new Error("Error entering raw repl");
    }
  };

  // send CTRL-C twice to stop any running program
  //port.write("\r\x03\x03", errCb);
  stopRunningStuff(port, errCb);

  // flush input
  port.flush(errCb);

  // enter raw repl (CTRL-A)
  port.write("\r\x01", errCb);

  if (softReset) {
    let data =
      (await readUntil(port, 1, "raw REPL; CTRL-B to exit\r\n>"))?.toString(
        "utf-8"
      ) ?? "";
    if (!data.endsWith("raw REPL; CTRL-B to exit\r\n>")) {
      throw new Error("Error entering raw repl");
    }

    // soft reset
    port.write("\x04", errCb);

    data =
      (await readUntil(port, 1, "soft reboot\r\n"))?.toString("utf-8") ?? "";
    if (!data.endsWith("soft reboot\r\n")) {
      throw new Error("Error entering raw repl");
    }
  }

  // TODO: maybe only convert the endswith string into a byte array at compile time
  // and check the subarray instead of converting the whole buffer to a string
  const data =
    (await readUntil(port, 1, "raw REPL; CTRL-B to exit\r\n"))?.toString(
      "utf-8"
    ) ?? "";
  if (!data.endsWith("raw REPL; CTRL-B to exit\r\n")) {
    throw new Error("Error entering raw repl");
  }
}

export function exitRawRepl(port: SerialPort): void {
  port.write("\r\x02", err => {
    if (err) {
      throw new Error("Error exiting raw repl");
    }
  });
}

/**
 * Listens to the output of the MicroPython REPL for a certain amount of time.
 *
 * @param port
 * @param timeout
 * @param receiver
 * @returns
 */
export async function follow(
  port: SerialPort,
  timeout: number | null,
  receiver?: (data: Buffer) => void
): Promise<{ data: string; error: string }> {
  // wait for output
  let data =
    (await readUntil(port, 1, "\x04", timeout, receiver))?.toString("utf-8") ??
    "";
  if (!data.endsWith("\x04")) {
    throw new Error("Error following output");
  }
  // remove last char from data
  data = data.slice(0, -1);

  // wait for an error if any
  let error =
    (await readUntil(port, 1, "\x04", timeout))?.toString("utf-8") ?? "";
  if (!error.endsWith("\x04")) {
    throw new Error("Error following output");
  }
  // remove last char from data
  error = error.slice(0, -1);

  // return both
  return { data, error };
}

/**
 * Reads a certain amount of bytes from the serial port or times out.
 *
 * @param port The serial port to read from.
 * @param bytes The number of bytes to read.
 * @param timeout Timeout in seconds.
 * @returns The data read from the serial port or null if the operation times out.
 */
async function readOrTimeout(
  port: SerialPort,
  bytes: number,
  timeout = 5
): Promise<Buffer | null> {
  if (port.readableLength >= bytes) {
    const data = port.read(bytes) as Buffer | null;
    ok(data !== null && data instanceof Buffer && data.length === bytes);

    return data;
  } else {
    return new Promise(resolve => {
      // eslint-disable-next-line prefer-const
      let timeoutId: NodeJS.Timeout;
      const onReadable = (): void => {
        if (port.readableLength >= bytes) {
          clearTimeout(timeoutId);
          port.off("readable", onReadable);
          resolve(port.read(bytes) as Buffer | null);
        } else {
          // TODO: maybe reset timeout
          // but timeout is often so long
          // that if you need to wait that long
          // ....
        }
      };

      timeoutId = setTimeout(() => {
        port.off("readable", onReadable);
        resolve(null);
      }, timeout * 1000);

      port.on("readable", onReadable);
    });
  }
}

/**
 * Executes a command on the MicroPython REPL using raw paste mode.
 *
 * IMPORTANT: The REPL must be in raw paste mode before calling this function.
 *
 * @param port The serial port to write to.
 * @param command The command to execute.
 * @throws Error if the write operation fails or a read operation times out.
 */
async function rawPasteWrite(port: SerialPort, command: Buffer): Promise<void> {
  const data = await readOrTimeout(port, 2);
  if (data === null) {
    throw new Error("Error executing command");
  }
  const windowSize = data.readUint16LE(0);
  let windowReamin = windowSize;

  // write the command bytes
  let i = 0;

  while (i < command.length) {
    /*const chunkSize = Math.min(windowReamin, command.length - i);
    port.write(command.subarray(i, i + chunkSize));
    windowReamin -= chunkSize;
    i += chunkSize;

    // wait for the next window size
    const data = await readOrTimeout(port, 1);
    if (data === null) {
      throw new Error("Error executing command");
    }
    windowReamin = data.readUint16LE(0);*/

    while (windowReamin === 0 || port.readableLength > 0) {
      const data = await readOrTimeout(port, 1);
      if (data?.equals(BUFFER_01)) {
        // device indicated that a new window of data can be sent
        windowReamin += windowSize;
      } else if (data?.equals(BUFFER_04)) {
        // device indicated abrubt end, acknoledge it and return
        port.write(BUFFER_04);

        return;
      } else {
        throw new Error("Unexpected read during raw paste");
      }

      // send as much data as possible that first within the allowed window
      const b = command.subarray(i, Math.min(i + windowReamin, command.length));
      port.write(b);
      windowReamin -= b.length;
      i += b.length;
    }

    // indicate end of data
    port.write(BUFFER_04);

    // wait for device to acknowledge the end of data
    const data2 = await readUntil(port, 1, BUFFER_04);
    // if data2 not ends with 0x04 then error
    if (!data2?.subarray(-BUFFER_04.length).equals(BUFFER_04)) {
      throw new Error("Error executing command");
    }
  }
}

/**
 * Executes a command on the MicroPython REPL and returns the result.
 *
 * @param port The serial port to write to.
 * @param command The command to execute.
 * @throws Error if the write operation fails.
 */
export async function executeCommandWithoutResult(
  port: SerialPort,
  command: string
): Promise<void> {
  const errCb = (err: Error | null | undefined): void => {
    if (err) {
      throw new Error("Error executing command");
    }
  };

  // check for prompt
  const data = (await readUntil(port, 1, ">"))?.toString("utf-8") ?? "";
  if (!data.endsWith(">")) {
    throw new Error("Error executing command");
  }

  // TODO: implement support for raw paste mode
  if (useRawPasteMode) {
    // try to enter raw paste mode
    port.write(BUFFER_RAW_PASTE_STATUS, errCb);
    const data = await readUntil(port, 2, "R\x01", 5);
    if (data?.equals(BUFFER_R00)) {
      // device understood raw-paste command but doesn't support it
      // because it understood we don't have to manually reenter raw repl
      //console.debug("Device doesn't support raw paste command");
    } else if (data?.equals(BUFFER_R01)) {
      //console.debug("Device supports raw paste command");
      // device understood raw-paste command and supports it
      await rawPasteWrite(port, Buffer.from(command, "utf-8"));

      return;
    } else {
      //console.debug("Device doesn't understand raw paste command");
      // device doesn't support raw-paste command fallback to normal raw REPL
      const data = await readUntil(port, 1, "w REPL; CTRL-B to exit\r\n>");
      if (!data?.toString("utf-8").endsWith("w REPL; CTRL-B to exit\r\n>")) {
        throw new Error("Error executing command");
      }
    }

    useRawPasteMode = false;
  }

  // write using raw REPL. 256 bytes every 10ms
  for (let i = 0; i < command.length; i += 256) {
    port.write(command.slice(i, i + 256), errCb);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // CTRL-D to finish
  port.write("\x04", errCb);

  // TODO: maybe different timeout
  const data2 = (await readUntil(port, 1, "OK", 5))?.toString("utf-8") ?? "";
  if (!data2.endsWith("OK")) {
    throw new Error("Error executing command");
  }
}

/**
 * Executes a command on the MicroPython REPL and returns the output.
 *
 * @param port The serial port to write to.
 * @param command The command to execute.
 * @param timeout The timeout in seconds to wait for the output.
 * @param receiver If provided, the function will be called
 * with the data received from the serial port when it arrives.
 * @throws Error if the write operation fails.
 * @returns
 */
export async function executeCommandWithResult(
  port: SerialPort,
  command: string,
  timeout: number | null = 10,
  receiver?: (data: Buffer) => void
): Promise<{
  data: string;
  error: string;
}> {
  // call exe without result and then call follow
  await executeCommandWithoutResult(port, command);

  return follow(port, timeout, receiver);
}

/**
 * Executes a command on the MicroPython REPL and returns the output.
 *
 * @param port The serial port to write to.
 * @param command The command to execute.
 * @param receiver If provided, the function will be called
 * with the data received from the serial port when it arrives.
 * @throws Error if the write operation fails or the command returns an error.
 * @returns
 */
export async function executeCommand(
  port: SerialPort,
  command: string,
  receiver?: (data: Buffer) => void,
  silentFail?: boolean
): Promise<string> {
  // TODO: remove timing
  const result = await executeCommandWithResult(
    port,
    command,
    // will use default timeout
    undefined,
    receiver
  );

  if (!silentFail && result.error !== "") {
    throw new Error(result.error);
  }

  return result.data;
}

// TODO: for this to work it is required that a working python interpreter is installed
/**
 * Aka. execute friendly command.
 *
 * Executes a command or evaluates and an expression on the connected board.
 *
 * @param port The serial port to write to.
 * @param expression The expression to evaluate.
 * @param pythonInterpreterPath The path to the python interpreter it can use.
 * @param emitter The function will listen to the relayInput event until the command finishes.
 * @returns Null if not error otherwise the error message.
 */
export async function evaluteExpression(
  port: SerialPort,
  expression: string | Buffer,
  pythonInterpreterPath: string,
  emitter: EventEmitter,
  receiver: (data: Buffer) => void
): Promise<string | null> {
  const command = wrapExpressionWithPrint(
    pythonInterpreterPath,
    expression instanceof Buffer ? expression.toString("utf-8") : expression
  );

  return executeCommandInteractive(port, command, emitter, receiver);
}

/**
 * Executes a command on the MicroPython REPL and returns the output.'
 * This function is used for interactive commands that have the can
 * receive user input.
 *
 * @param port The serial port to write to.
 * @param command The command to execute.
 * @param emitter The event emitter to listen to for relayInput events.
 * @param receiver The function to call with the data received from the serial port.
 * @returns Null if no error otherwise the error message.
 */
export async function executeCommandInteractive(
  port: SerialPort,
  command: string | Buffer,
  emitter: EventEmitter,
  receiver: (data: Buffer) => void
): Promise<string | null> {
  // listen to emiter for relayInput events and send the data to the board
  // until the executeCommandWithResponse promise resolves
  let relayOpen = false;

  const onRelayInput = (data: Buffer): void => {
    if (!relayOpen) {
      // discards any input that arrives before the command has been sent
      return;
    }
    port.write(data, err => {
      if (err) {
        throw new Error("Error evaluating expression");
      }
    });
  };

  emitter.on(PicoSerialEvents.relayInput, onRelayInput);

  try {
    relayOpen = true;
    // doesn't store response until return as receiver is provided
    const { error } = await executeCommandWithResult(
      port,
      command instanceof Buffer ? command.toString("utf-8") : command,
      null,
      receiver
    );
    if (error !== "") {
      throw new Error(error);
    }
  } catch (error) {
    return error instanceof Error
      ? error.message
      : typeof error === "string"
      ? error
      : "Unknown error";
  } finally {
    // remove listener
    emitter.off(PicoSerialEvents.relayInput, onRelayInput);
  }

  return null;
}

export async function fsExists(
  port: SerialPort,
  target = ""
): Promise<boolean> {
  try {
    await executeCommand(port, `import os\nos.stat('${target}')`);

    return true;
  } catch {
    return false;
  }
}

/**
 * Lists the contents of a directory on the connected board.
 *
 * @param port The serial port to write to.
 * @param target The target directory to list the contents of.
 * @returns A list of files and directories in the target directory.
 */
export async function fsListContents(
  port: SerialPort,
  target?: string
): Promise<FileData[]> {
  const remotePath = target
    ? target.startsWith(":")
      ? target.slice(1)
      : target
    : undefined;

  try {
    const result = await executeCommand(
      port,
      `import os\nfor f in os.ilistdir(${
        remotePath ? `"${remotePath}"` : ""
      }):\n` +
        " print('{:12} {}{}'.format(f[3]if len(f)>3 else 0,f[0],'/'if f[1]&0x4000 else ''))"
    );

    return parseListContentsPacket(result);
  } catch (error) {
    console.error(error);

    return [];
  }
}

export async function fsListContentsRecursive(
  port: SerialPort,
  target = ""
): Promise<FileData[]> {
  // keep indentation as small as possible
  // to reduce the amount of bytes sent
  // TODO: add max depth !!
  const cmd = `
import os
def __pe_recursive_ls(src):
 for f in os.ilistdir(src):
  is_dir = f[1] & 0x4000
  if is_dir:
   recursive_ls(src + ('/' if src[-1] != '/' else '') + f[0])
  else:
   path = src + ('/' if src[-1] != '/' else '') + f[0]
   print('{:12} {}{}'.format(f[3] if len(f) > 3 else 0, path, '/' if is_dir else ''))
__pe_recursive_ls(${target ? `'${target}'` : ""})
del __pe_recursive_ls
`;

  try {
    const result = await executeCommand(port, cmd);

    return parseListContentsPacket(result);
  } catch {
    return [];
  }
}

export async function fsStat(
  port: SerialPort,
  item: string
): Promise<FileData | undefined> {
  // keep indentation as small as possible
  // to reduce the amount of bytes sent
  // TODO: maybe move computation from board to host
  // os.stat_result(insert the eval result of repr(os.stat))
  const command = `
import os
def __pe_get_file_info(file_path):
 stat = uos.stat(file_path)
 creation_time = stat[9]
 modification_time = stat[8]
 size = stat[6]
 print('{"creationTime": ' + str(creation_time) + ', "modificationTime": ' + str(modification_time) + ', "size": ' + str(size) + ', "isDir": ' + str((stat[0] & 0o170000) == 0o040000).lower() + '}')
`;

  try {
    const result = await executeCommand(
      port,
      command +
        `__pe_get_file_info('${item}')\n` +
        // cleanup memory
        "del __pe_get_file_info"
    );

    const statResponse = parseStatJson(result);

    return {
      isDir: statResponse.isDir,
      size: statResponse.size,
      path: item,
      lastModified: new Date(statResponse.modificationTime * 1000),
      created: new Date(statResponse.creationTime * 1000),
    };
  } catch {
    return undefined;
  }
}

export async function fsCopy(
  port: SerialPort,
  source: string,
  dest: string,
  chunkSize = 256,
  progressCallback?: (written: number, srcSize: number) => void
): Promise<void> {
  let srcSize = 0;
  let written = 0;
  if (progressCallback) {
    const stat = await fsStat(port, source);
    if (stat === undefined) {
      throw new Error("Source file not found");
    }
    srcSize = stat.size;
  }
  await executeCommand(
    port,
    `
__pe_fr=open('${source}','rb')
__pe_r=__pe_fr.read
__pe_fw=open('${dest}','wb')
__pe_w=__pe_fw.write
`
  );

  while (true) {
    const sizeStr = await executeCommand(
      port,
      `
__pe_d=__pe_r(${chunkSize})
__pe_w(__pe_d)
print(len(__pe_d))
`
    );
    if (sizeStr.length === 0) {
      throw new Error("Error copying file");
    }
    const size = parseInt(sizeStr);
    if (isNaN(size)) {
      throw new Error("Error copying file");
    }

    if (progressCallback) {
      written += size;
      progressCallback(written, srcSize);
    }

    await executeCommand(port, "__pe_fr.close()\n__pe_fw.close()");
  }
}

export async function fsGet(
  port: SerialPort,
  source: string,
  dest: string,
  chunkSize = 256,
  progressCallback?: (written: number, srcSize: number) => void
): Promise<void> {
  let srcSize = 0;
  let written = 0;
  const filename = basename(source);
  const target = dest.endsWith(filename) ? dest : dest + "/" + filename;

  if (progressCallback) {
    const stat = await fsStat(port, source);
    if (stat === undefined) {
      throw new Error("Source file not found");
    }
    srcSize = stat.size;
  }

  await executeCommand(
    port,
    `__pe_f=open('${source}','rb')\n__pe_r=__pe_f.read`
  );

  let destFile: FileHandle | undefined = undefined;
  try {
    // open dest file as write binary local
    destFile = await hostFsOpen(target, "w");
    while (true) {
      let buffer = Buffer.alloc(0);
      await executeCommand(port, `print(__pe_r(${chunkSize}))`, data => {
        buffer = Buffer.concat([buffer, data]);
      });
      const expectedEnding = Buffer.from("\r\n\x04", "utf8");
      // assert that the buffer ends with the expected sequence
      const bufferEndsWith = buffer
        .subarray(-expectedEnding.length)
        .equals(expectedEnding);

      ok(
        bufferEndsWith,
        "Data does not end with the expected byte sequence: " +
          expectedEnding.toString("hex")
      );

      // TODO: maybe add more validation of the ioncoming
      // data to ensure it can be interpreted correctly

      // skip first bytes b' and last bytes \r\n\x04 plus '
      const encodedData = buffer.subarray(2, -expectedEnding.length - 1);

      // empty bytes object means end of file
      if (encodedData.length === 0) {
        break;
      }

      // following escape sequences are supported:
      // https://docs.python.org/3/reference/lexical_analysis.html#escape-sequences
      // write buffer to file
      // Python promisses that each char within the string repr of
      // a bytes object is a valid ascii char
      //await destFile.write(parseEscapedString(encodedData.toString("ascii")));
      await writeEncodedBufferToFile(encodedData.toString("ascii"), destFile);

      if (progressCallback) {
        written += buffer.length;
        progressCallback(written, srcSize);
      }
    }
  } finally {
    // close the file
    await destFile?.close();
  }

  await executeCommand(port, "__pe_f.close()");
}

export async function fsPut(
  port: SerialPort,
  source: string,
  dest: string,
  chunkSize = 256,
  progressCallback?: (written: number, srcSize: number) => void
): Promise<void> {
  let srcSize = 0;
  let written = 0;

  const filename = basename(source);
  const target = dest.endsWith(filename) ? dest : dest + "/" + filename;

  // TODO: only open file once and in the try catch
  if (progressCallback) {
    const stat = await hostFsOpen(source, "r");
    srcSize = (await stat.stat()).size;
    await stat.close();
  }

  await executeCommand(
    port,
    `__pe_f=open('${target}','wb')\n__pe_w=__pe_f.write`
  );

  let srcFile: FileHandle | undefined = undefined;
  try {
    // open source file as read binary local
    srcFile = await hostFsOpen(source, "r");
    if (srcFile === undefined) {
      throw new Error("Source file not found");
    }
    while (true) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await srcFile.read(buffer, 0, chunkSize);
      if (bytesRead === 0) {
        break;
      }

      // write buffer to file
      await executeCommand(
        port,
        `__pe_w(b'${encodeStringToEscapedBin(buffer)}')`
      );

      if (progressCallback) {
        written += bytesRead;
        progressCallback(written, srcSize);
      }
    }
  } finally {
    // close the file
    await srcFile?.close();
  }

  await executeCommand(port, "__pe_f.close()");
}

export async function fsMkdir(port: SerialPort, target: string): Promise<void> {
  await executeCommand(port, `import os\nos.mkdir('${target}')`);
}

export async function fsRmdir(port: SerialPort, target: string): Promise<void> {
  await executeCommand(port, `import os\nos.rmdir('${target}')`);
}

/**
 * Removes a directory and all its contents from the connected board.
 * If the operation fails, an error is thrown.
 *
 * @param port The serial port to write to.
 * @param target The target directory to remove.
 * @throws An rmdir recursive failed.
 */
export async function fsRmdirRecursive(
  port: SerialPort,
  target: string
): Promise<void> {
  //const commandShort = `import os; def __pe_deltree(target): [__pe_deltree((current:=target + d) if target == '/' else (current:=target + '/' + d)) or os.remove(current) for d in os.listdir(target)]; os.rmdir(target) if target != '/' else None; __pe_deltree('${target}'); del __pe_deltree`;

  // doesn't allow to delete root directory
  const command = `
import os
def __pe_deltree(target):
 for d in os.listdir(target):
  current = target.rstrip('/') + '/' + d
  try:
   __pe_deltree(current)
  except OSError:
   os.remove(current)
 if target != '/':
  os.rmdir(target)
__pe_deltree('${target}')
del __pe_deltree
`;

  await executeCommand(port, command);
}

export async function fsRemove(
  port: SerialPort,
  target: string
): Promise<void> {
  await executeCommand(port, `import os\nos.remove('${target}')`);
}

export async function fsRename(
  port: SerialPort,
  oldName: string,
  newName: string
): Promise<void> {
  // TODO: maybe guard with try except
  await executeCommand(port, `import os\nos.rename('${oldName}','${newName}')`);
}

export async function fsTouch(port: SerialPort, target: string): Promise<void> {
  await executeCommand(port, `__pe_f=open('${target}','a')\n__pe_f.close()`);
}

export async function fsIsDir(
  port: SerialPort,
  target: string
): Promise<boolean> {
  const command = `
import os
def __pe_is_dir(file_path):
 try:
  return (os.stat(file_path)[0] & 0o170000) == 0o040000
 except OSError:
  return False
print(__pe_is_dir('${target}'))
del __pe_is_dir
`;

  const { data, error } = await executeCommandWithResult(port, command);

  if (error !== "") {
    throw new Error(error);
  }

  return data === "True";
}

/**
 * Calculates the hash of a file on the connected board.
 *
 * NOTE: it does not check if a path actually points to a file.
 *
 * @param port The serial port to write to.
 * @param files The file to calculate the hash of.
 * @returns The hashes of the files.
 */
export async function fsCalcFilesHashes(
  port: SerialPort,
  files: string
): Promise<HashResponse[]> {
  const command = `
import uhashlib
import ubinascii
import os
import json

def __pe_hash_file(file):
 try:
  if os.stat(file)[6] > 200 * 1024:
   print(json.dumps({"file": file, "error": "File too large"}))
   return
  with open(file, 'rb') as f:
   h = uhashlib.sha256()
   while True:
    data = f.read(512)
    if not data:
     break
    h.update(data)
   print(json.dumps({"file": file, "hash": ubinascii.hexlify(h.digest()).decode()}))
 except Exception as e:
  print(ujson.dumps({"file": file, "error": f"{e.__class__.__name__}: {e}"}))
`;

  await executeCommand(port, command);

  const hashes: HashResponse[] = [];
  for (const file of files) {
    try {
      const hashJson = await executeCommand(port, `__pe_hash_file('${file}')`);
      const hashResponse = parseHashJson(hashJson);
      if (hashResponse.error) {
        console.error(
          `Failed to hash file: ${file} with error: ${hashResponse.error}`
        );
      } else {
        hashes.push(hashResponse);
      }
    } catch (error) {
      console.error(error);
    }
  }

  await executeCommand(port, "del __pe_hash_file");

  return hashes;
}

export async function runFile(
  port: SerialPort,
  file: string,
  emitter: EventEmitter,
  receiver: (data: Buffer) => void
): Promise<void> {
  let fileHandle: FileHandle | undefined = undefined;
  try {
    fileHandle = await hostFsOpen(file, "r");
    let data = await fileHandle.readFile();
    // close as soon as possible so user can continue editing
    await fileHandle?.close();

    // TODO: maybe not upload and enter full file at once in one command
    if (file.endsWith(".mpy") && data[0] === 77) {
      await executeCommand(
        port,
        `_injected_buf=b'${encodeStringToEscapedBin(data)}'`
      );
      data = Buffer.from(injectedImportHookCode, "utf-8");
    }
    const error = await executeCommandInteractive(
      port,
      data,
      emitter,
      receiver
    );
    if (error) {
      throw new Error(error);
    }
  } finally {
    await fileHandle?.close();
  }
}
/**
 * Synchronizes the RTC of the connected board with the current time.
 * If no the board does not support the RTC api it will throw an error.
 *
 * @param port The serial port to write to.
 * @throws An error if the RTC api is not available or the command fails.
 */
export async function syncRtc(port: SerialPort): Promise<void> {
  const now = new Date();

  const command = `
from machine import RTC as __pe_RTC
__pe_RTC().datetime(${dateToRp2Datetime(now)})
del __pe_RTC
`;

  await executeCommand(port, command);
}

/**
 * Gets the current time from the RTC of the connected board.
 * If the board does not support the RTC api it will throw an error.
 *
 * @param port The serial port to write to.
 * @returns The current time from the RTC of the board.
 * If response cannot be parsed, null is returned.
 * @throws An error if the RTC api is not available or the command fails.
 */
export async function getRtcTime(port: SerialPort): Promise<Date | null> {
  const command = `
from machine import RTC as __pe_RTC
print(__pe_RTC().datetime())
del __pe_RTC
`;

  const result = await executeCommand(port, command);

  return rp2DatetimeToDate(result);
}

// TODO: needs more work to be able to continue connection and receive output
export async function hardReset(
  port: SerialPort,
  receiver?: (data: Buffer) => void
): Promise<void> {
  stopRunningStuff(port);
  await executeCommand(
    port,
    "\rimport machine\nmachine.reset()",
    receiver,
    true
  );
}
