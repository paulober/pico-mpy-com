import { ok } from "assert";
import type { FileHandle } from "fs/promises";

/**
 * Replace simple escape sequences in a string with their respective characters.
 * (only escape sequences used by the python bytes object)
 *
 * @param str The string to process.
 * @returns The string with all simple escape sequences replaced.
 */
function replaceSimpleEscapeSequences(str: string): string {
  // TODO: single pass maybe loop or match any \any and then replace with lambda
  return (
    str // TODO: support that there is no extra backslashes in front of the escape sequences
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\a/g, "\x07") // Bell/alert
      // eslint-disable-next-line no-control-regex
      .replace(/\\\x07/g, "\\a") // Intentional escape sequence
      // DOES HAVE MANY ISSUES
      //.replace(/\\b/g, "\b") // Backspace
      .replace(/\\f/g, "\f") // Form feed
      .replace(/\\\f/g, "\\f") // Intentional escape sequence
      .replace(/\\n/g, "\n") // New line
      .replace(/\\\n/g, "\\n") // Intentional escape sequence
      .replace(/\\r/g, "\r") // Carriage return
      .replace(/\\\r/g, "\\r") // Intentional escape sequence
      .replace(/\\t/g, "\t") // Tab
      .replace(/\\\t/g, "\\t") // Intentional escape sequence
      .replace(/\\v/g, "\v") // Vertical tab
      .replace(/\\\v/g, "\\v") // Intentional escape sequence
    // don't do this as escaped backslashes are handled also
    // below where if \ after \ it will only print one
    // and also they are needed to identify intentional escape sequences by the user below
    //.replace(/\\\\/g, "\\")  // Backslash
  );
}

/**
 * Decode an escaped ASCII representation of a binary chunk
 * and write it to a file.
 *
 * @param escaped The escaped ASCII string to parse.
 * @param fileHandle The file handle to write the binary data to.
 */
export async function writeEncodedBufferToFile(
  escaped: string,
  fileHandle: FileHandle
): Promise<void> {
  // first replace simple escape sequences
  const processed = replaceSimpleEscapeSequences(escaped);

  const binaryData = Buffer.from(processed, "utf-8");
  const cache: number[] = [];
  let waitingForHex = false;
  for (const byte of binaryData) {
    // if the byte is a backslash
    // - store it in cache
    // - go to next byte
    // - if it is not an x write the cache and it to the fileHandle
    // - if it is an x clear the cache and store the next two bytes
    // - these two bytes are one hex number so convert them to one number
    // - write the number to the fileHandle
    // if the byte is not a backslash write it to the fileHandle

    if (cache.length === 0) {
      if (!waitingForHex && byte === 92) {
        cache.push(byte);
      } else if (!waitingForHex) {
        await fileHandle.write(Buffer.from([byte]));
      } else {
        // waiting for hex
        cache.push(byte);
      }
    } else if (cache.length === 1 && !waitingForHex) {
      // first detected \ is in cache

      if (byte === 120) {
        cache.length = 0;
        waitingForHex = true;
      } else if (byte === 92) {
        // second backslash,
        // means first one was false alarm, write one as the first one escaped the second one
        await fileHandle.write(Buffer.from(cache));
        cache.length = 0;
      } else {
        // ok, false alarm, put everything into file and reset cache
        await fileHandle.write(Buffer.from(cache));
        await fileHandle.write(Buffer.from([byte]));
        cache.length = 0;
      }
    } else if (cache.length === 1 && waitingForHex) {
      // first part of hex number is in cache
      cache.push(byte);

      // convert the two parts of the hex numbers to one number and then to decimal
      const hexNumber = parseInt(
        cache.map(code => String.fromCharCode(code)).join(""),
        16
      );

      await fileHandle.write(Buffer.from([hexNumber]));
      cache.length = 0;
      waitingForHex = false;
    }
  }
}

/**
 * Decode the values of escape simple escape sequences with their
 * respective characters for the string representation of them.
 *
 * @param str The string to process.
 * @returns The string with all simple escape sequences replaced.
 */
function encodeSimpleEscapeSequences(str: string): string {
  return (
    str
      // not required
      //.replace(/\\n/g, "\\\\n") // New line esc sequence by the user
      //.replace(/\\t/g, "\\\\t") // Tab esc sequence by the user
      //.replace(/\\r/g, "\\\\r") // Carriage return esc sequence by the user
      //.replace(/\\f/g, "\\\\f") // Form feed esc sequence by the user
      //.replace(/\\b/g, "\\\\b") // Backspace esc sequence by the user
      //.replace(/\\v/g, "\\\\v") // Vertical tab esc sequence by the user
      //.replace("\\x07", "\\\\x07") // Bell/alert esc sequence by the user
      //.replace(/\\/g, "\\\\") // Backslash

      .replace(/\n/g, "\\n") // New line
      .replace(/\t/g, "\\t") // Tab
      .replace(/\r/g, "\\r") // Carriage return
      .replace(/\f/g, "\\f") // Form feed
      .replace("\b", "\\b") // Backspace
      .replace(/\v/g, "\\v") // Vertical tab
      .replace("\x07", "\\a") // Bell/alert
      .replace(/'/g, "\\'") // Single quote
      .replace(/"/g, '\\"') // Double quote
  );
}

/**
 * Encode a string to its escaped representation.
 * Supports encoding of simple escape sequences, hex, and octal.
 *
 * @param input The input string to encode.
 * @returns The escaped string with all special characters replaced
 * by their respective escape sequences.
 */
export function encodeStringToEscaped(input: string): string {
  // First, encode the simple escape sequences
  const processed = encodeSimpleEscapeSequences(input);

  let encoded = "";
  for (let i = 0; i < processed.length; i++) {
    const charCode = processed.charCodeAt(i);

    if (charCode < 32 || charCode > 126) {
      const hex = Buffer.from(processed[i], "utf-8").toString("hex");
      // if there is a problem here just insert test to prepend a leading zero
      ok(hex.length % 2 === 0 && hex.length >= 2);
      //const hex = charCode.toString(16);
      encoded += hex
        .match(/.{2}/g)
        ?.map(pair => `\\x${pair}`)
        .join("");
    } else {
      // No need to encode printable ASCII characters
      encoded += processed[i];
    }
  }

  return encoded;
}

/**
 * Encode a string to its escaped representation (ascii conform).
 *
 * @param input The input string to encode.
 * @param bytes The number of bytes to encode and return from the start of the buffer.
 * Defaults to all.
 * @returns The escaped string with all special characters replaced
 */
export function encodeStringToEscapedBin(
  input: Buffer,
  bytes?: number
): string {
  bytes = bytes ?? input.length;
  if (bytes <= 0) {
    return "";
  }

  let encoded = "";
  let i = 0;
  for (const byte of input) {
    i++;
    const charCode = byte;

    if (charCode < 32 || charCode > 126) {
      const hexValue = charCode.toString(16).padStart(2, "0");
      //const hex = charCode.toString(16);
      encoded += `\\x${hexValue}`;
    } else {
      // single ' == 39
      if (charCode === 39) {
        encoded += "\\'";
      } else if (charCode === 92) {
        encoded += "\\\\";
      } else {
        // No need to encode printable ASCII characters
        encoded += String.fromCharCode(charCode);
      }
    }

    // check at the end to not start the loop again
    if (i === bytes) {
      break;
    }
  }

  return encoded;
}
