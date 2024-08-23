import { ok } from "assert";
import type { FileHandle } from "fs/promises";

function replaceSimpleEscapeSequences(str: string): string {
  // TODO: single pass maybe loop or match any \any and then replace with lambda
  return str
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\a/g, "\x07") // Bell/alert
    .replace(/\\b/g, "\b") // Backspace
    .replace(/\\f/g, "\f") // Form feed
    .replace(/\\n/g, "\n") // New line
    .replace(/\\r/g, "\r") // Carriage return
    .replace(/\\t/g, "\t") // Tab
    .replace(/\\v/g, "\v") // Vertical tab
    .replace(/\\\\/g, "\\"); // Backslash
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
        // mean first one was false alarm, write one and keep one in cache
        // because it could be the the second one is now starting an escape sequence
        await fileHandle.write(Buffer.from([byte]));
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

function encodeSimpleEscapeSequences(str: string): string {
  return str
    .replace(/\\/g, "\\\\") // Backslash
    .replace(/\n/g, "\\n") // New line
    .replace(/\t/g, "\\t") // Tab
    .replace(/\r/g, "\\r") // Carriage return
    .replace(/\f/g, "\\f") // Form feed
    .replace("\b", "\\b") // Backspace
    .replace(/\v/g, "\\v") // Vertical tab
    .replace("\x07", "\\a") // Bell/alert
    .replace(/'/g, "\\'") // Single quote
    .replace(/"/g, '\\"'); // Double quote
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

export function encodeStringToEscapedBin(input: Buffer): string {
  let encoded = "";
  for (const byte of input) {
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
  }

  return encoded;
}
