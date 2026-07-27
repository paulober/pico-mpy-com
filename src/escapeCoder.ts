import { ok } from "assert";
import type { FileHandle } from "fs/promises";

// Single-byte escape sequences a Python bytes repr can emit. Every other
// non-printable byte is emitted as \xNN and handled separately below.
const SIMPLE_ESCAPES: Record<string, number> = {
  "\\": 0x5c,
  "'": 0x27,
  '"': 0x22,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  v: 0x0b,
};

/**
 * Decode the ASCII string repr of a Python bytes object (as sent by the board
 * during a download) back into the exact raw bytes and write them to a file.
 *
 * Decoding is a single left-to-right pass over the escape sequences. A naive
 * regex pre-pass corrupts data whose bytes happen to look like escape
 * sequences — e.g. a backslash (0x5c) followed by a newline (0x0a) was turned
 * into a backslash followed by 'n' (0x6e). See MicroPico #319.
 *
 * @param escaped The escaped ASCII string (repr content without the b'...' wrapper).
 * @param fileHandle The file handle to write the decoded binary data to.
 */
export async function writeEncodedBufferToFile(
  escaped: string,
  fileHandle: FileHandle
): Promise<void> {
  // The decoded output is never longer than the escaped input.
  const out = Buffer.allocUnsafe(escaped.length);
  let len = 0;

  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] !== "\\") {
      out[len++] = escaped.charCodeAt(i);
      continue;
    }

    const next = escaped[i + 1];
    if (next === "x") {
      out[len++] = parseInt(escaped.slice(i + 2, i + 4), 16);
      i += 3;
    } else if (next !== undefined && next in SIMPLE_ESCAPES) {
      out[len++] = SIMPLE_ESCAPES[next];
      i += 1;
    } else {
      // Lone trailing backslash — should not occur in a valid repr; keep it.
      out[len++] = 0x5c;
    }
  }

  await fileHandle.write(out.subarray(0, len));
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
