import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PicoMpyCom } from "../picoMpyCom.js";
import { OperationResultType } from "../operationResult.js";
import {
  getTestBoard,
  integrationBoardAvailable,
  type TestBoard,
} from "./board.js";

// End-to-end tests of the library's core operations against a real MicroPython
// REPL — the simulator by default, or a physical board via MICROPICO_TEST_PORT.
// These are the "green == core features work" tests. Operations the Unix-port
// simulator cannot f. reproduce faithfully (soft reset = Ctrl-D exits it; the
// file-transfer read protocol differs) are marked hardware-only and skipped on
// the simulator; run them against a board with MICROPICO_TEST_PORT set.

// When a real port is given we are on hardware; otherwise on the simulator.
const ON_SIMULATOR = process.env.MICROPICO_TEST_PORT === undefined;
const hardwareOnly = ON_SIMULATOR
  ? { skip: "hardware only (not reproducible on the Unix-port simulator)" }
  : {};

describe(
  "integration: core board operations",
  {
    skip: integrationBoardAvailable()
      ? false
      : "no board and no simulator (install micropython + socat)",
  },
  () => {
    let board: TestBoard;
    const com = PicoMpyCom.getInstance();

    before(async () => {
      board = await getTestBoard();
      await com.openSerialPort(board.port);
      await new Promise(resolve => setTimeout(resolve, 2500));
    });

    after(async () => {
      await com.closeSerialPort();
      await board.dispose();
    });

    async function evalOut(code: string): Promise<string> {
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

    test("runs code and returns the value", async () => {
      assert.match(await evalOut("40 + 2"), /42/);
    });

    test("#282: a raw byte literal is not double-encoded", async () => {
      const out = await evalOut("b'\\xAA'");
      assert.match(out, /b'\\xaa'/);
      assert.doesNotMatch(out, /xc2/);
    });

    test("#282: a printable byte literal round-trips", async () => {
      assert.match(await evalOut("b'\\x7a'"), /b'z'/);
    });

    test("#315: a bare `stmt; expr` line prints its value", async () => {
      assert.match(await evalOut("import os; os.listdir()"), /\[/);
    });

    test("creates and lists files on the board", async () => {
      await evalOut("_f=open('a.txt','w'); _f.write('hi'); _f.close()");
      const listing = await evalOut("import os; print(os.listdir())");
      assert.match(listing, /a\.txt/);
    });

    test(
      "#319: downloads binary data without corruption",
      hardwareOnly,
      async () => {
        // bytes e0 09 5c 0a e0 09 — contains a backslash (0x5c) + newline (0x0a)
        await evalOut(
          "_f=open('bin.dat','wb'); " +
            "_f.write(bytes([0xe0,0x09,0x5c,0x0a,0xe0,0x09])); _f.close()"
        );
        const dir = await mkdtemp(join(tmpdir(), "mpy-dl-"));
        try {
          const res = await com.downloadFiles(["bin.dat"], dir);
          assert.equal(res.type, OperationResultType.commandResult);
          const got = await readFile(join(dir, "bin.dat"));
          assert.equal(got.toString("hex"), "e0095c0ae009");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    );

    test("soft reset leaves the board responsive", hardwareOnly, async () => {
      const res = await com.softReset();
      assert.notEqual(res.type, OperationResultType.none);
      assert.match(await evalOut("1 + 1"), /2/);
    });
  }
);
