import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PicoMpyCom } from "./picoMpyCom.js";

// On-target regression tests. These talk to a REAL MicroPython board over
// serial and reproduce specific fixed bugs, so a regression that unit tests
// (with a fake port) cannot see is caught against real firmware.
//
//   npm run test:hw            (auto-detects a connected board)
//   MICROPICO_TEST_PORT=/dev/... npm run test:hw
//
// The whole suite is skipped when no board is connected, so it never breaks CI.

async function detectBoard(): Promise<string | undefined> {
  if (process.env.MICROPICO_TEST_PORT) {
    return process.env.MICROPICO_TEST_PORT;
  }
  try {
    return (await PicoMpyCom.getSerialPorts())[0];
  } catch {
    return undefined;
  }
}

const boardPort = await detectBoard();

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

describe(
  "hardware: comm regressions",
  { skip: boardPort ? false : "no MicroPython board connected" },
  () => {
    const com = PicoMpyCom.getInstance();

    before(async () => {
      // Narrows the type; the suite is already skipped when no board is found.
      if (!boardPort) {
        return;
      }
      await com.openSerialPort(boardPort);
      // allow the raw-REPL setup to complete
      await sleep(2500);
    });

    after(async () => {
      await com.closeSerialPort();
    });

    async function evalOutput(code: string): Promise<string> {
      const chunks: Buffer[] = [];
      await com.runFriendlyCommand(
        code,
        () => {},
        data => chunks.push(Buffer.from(data)),
        undefined,
        true
      );

      return Buffer.concat(chunks).toString("utf8");
    }

    test("evaluates a simple expression", async () => {
      assert.match(await evalOutput("40 + 2"), /42/);
    });

    test("#282: a raw byte in a bytes literal is not double-encoded", async () => {
      const out = await evalOutput("b'\\xAA'");
      assert.match(out, /b'\\xaa'/);
      assert.doesNotMatch(out, /xc2/);
    });

    test("#282: printable byte literal round-trips", async () => {
      assert.match(await evalOutput("b'\\x7a'"), /b'z'/);
    });

    test("#319: binary download preserves backslash+newline byte pairs", async () => {
      const dir = await mkdtemp(join(tmpdir(), "micropico-hw-"));
      try {
        // int16 LE 2528, 2652, 2528 -> bytes e0 09 5c 0a e0 09 (contains 5c 0a)
        await evalOutput(
          "import struct; _f=open('hwtest.raw','wb'); " +
            "_f.write(struct.pack('<h',2528)); " +
            "_f.write(struct.pack('<h',2652)); " +
            "_f.write(struct.pack('<h',2528)); _f.close()"
        );

        const res = await com.downloadFiles(["hwtest.raw"], dir);
        assert.equal(res.type, 2 /* commandResult */);

        const got = await readFile(join(dir, "hwtest.raw"));
        assert.equal(got.toString("hex"), "e0095c0ae009");
      } finally {
        await evalOutput("import os; os.remove('hwtest.raw')");
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
);
