import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PicoMpyCom } from "../picoMpyCom.js";
import { OperationResultType } from "../operationResult.js";
import { PicoSerialEvents } from "../picoSerialEvents.js";
import type {
  OpResultListContents,
  OpResultGetItemStat,
} from "../operationResult.js";
import type FileData from "../fileData.js";
import {
  getTestBoard,
  integrationBoardAvailable,
  type TestBoard,
} from "./board.js";

// End-to-end tests of the library's core operations against a real MicroPython
// REPL — the simulator by default, or a physical board via MICROPICO_TEST_PORT.
// These are the "green == core features work" tests: run code, list files,
// upload, download. Only operations the Unix-port simulator genuinely cannot
// reproduce (soft reset = Ctrl-D exits the interpreter) are marked hardware-only
// and skipped on the simulator; run them against a board with MICROPICO_TEST_PORT.

// When a real port is given we are on hardware; otherwise on the simulator.
const ON_SIMULATOR = process.env.MICROPICO_TEST_PORT === undefined;
const hardwareOnly = ON_SIMULATOR
  ? { skip: "hardware only (not reproducible on the Unix-port simulator)" }
  : {};

/** Why the suite must not run, or false when it may. */
function suiteSkipReason(): string | false {
  if (!integrationBoardAvailable()) {
    return "no board and no simulator (install micropython + socat)";
  }
  // Every test starts by wiping the board root, which on a real board deletes
  // the user's files — so hardware runs have to opt in explicitly.
  if (!ON_SIMULATOR && process.env.MICROPICO_TEST_ALLOW_WIPE !== "1") {
    return "wipes the board: set MICROPICO_TEST_ALLOW_WIPE=1 to run it";
  }

  return false;
}

/** Rejects with `what` if `promise` does not settle within `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} (after ${ms}ms)`)),
          ms
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

describe(
  "integration: core board operations",
  {
    skip: suiteSkipReason(),
  },
  () => {
    let board: TestBoard;
    let root = "/";
    const com = PicoMpyCom.getInstance();

    /** Join a name onto the board root without producing a double slash. */
    const rp = (name: string): string =>
      root === "/" ? `/${name}` : `${root}/${name}`;

    before(async () => {
      board = await getTestBoard();
      root = board.root;
      await com.openSerialPort(board.port);
      await waitUntilReady();
    });

    /**
     * Waits for the port to open, then runs a first command. Operations queue
     * until the raw-REPL handshake is done, so that command doubles as the
     * readiness check. Bounded, so a broken backend fails instead of hanging.
     */
    async function waitUntilReady(): Promise<void> {
      const deadline = Date.now() + 15000;
      while (com.isPortDisconnected()) {
        assert.ok(Date.now() < deadline, "port did not open");
        await sleep(50);
      }
      const ready = evalOut("1 + 1");
      assert.match(await withTimeout(ready, 15000, "board not ready"), /2/);
    }

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

    /** Names present in a directory listing (basenames on the board). */
    async function listNames(remote: string): Promise<string[]> {
      const res = await com.listContents(remote);
      assert.equal(res.type, OperationResultType.listContents);

      // directories come back with a trailing slash ("data/"); strip it before
      // taking the basename so both files and folders yield a bare name.
      return (res as OpResultListContents).contents.map(c =>
        c.path.replace(/\/$/, "").replace(/^.*\//, "")
      );
    }

    /** Stat an item on the board, asserting the operation succeeded. */
    async function statOf(item: string): Promise<FileData | null> {
      const res = await com.getItemStat(item);
      assert.equal(res.type, OperationResultType.getItemStat);

      return (res as OpResultGetItemStat).stat;
    }

    // Wipe the current working directory (the board root on both hardware and
    // the simulator). Deliberately cwd-relative — never an absolute "/", which
    // on the Unix-port simulator would target the host filesystem root.
    async function wipeBoard(): Promise<void> {
      await evalOut(
        "import os\n" +
          "def __w(p):\n" +
          " for e in os.listdir(p):\n" +
          "  f=p+'/'+e\n" +
          "  try:\n" +
          "   os.remove(f)\n" +
          "  except OSError:\n" +
          "   __w(f); os.rmdir(f)\n" +
          "__w('.')\n" +
          "del __w"
      );
    }

    beforeEach(async () => {
      await wipeBoard();
    });

    // ---- core execution -------------------------------------------------

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

    // ---- filesystem -----------------------------------------------------

    test("creates and lists files on the board", async () => {
      await evalOut("_f=open('a.txt','w'); _f.write('hi'); _f.close()");
      assert.ok((await listNames(root)).includes("a.txt"));
    });

    test("creates and removes directories (mkdir/rmdir)", async () => {
      let res = await com.createFolders([rp("data")]);
      assert.equal(res.type, OperationResultType.commandResult);
      assert.ok((await listNames(root)).includes("data"));

      res = await com.deleteFolders([rp("data")]);
      assert.equal(res.type, OperationResultType.commandResult);
      assert.ok(!(await listNames(root)).includes("data"));
    });

    test("removes a non-empty directory (rmtree)", async () => {
      await com.createFolders([rp("pkg")]);
      await evalOut("_f=open('pkg/m.py','w'); _f.write('x=1'); _f.close()");
      assert.ok((await listNames(rp("pkg"))).includes("m.py"));

      const res = await com.deleteFolderRecursive(rp("pkg"));
      assert.equal(res.type, OperationResultType.commandResult);
      assert.ok(!(await listNames(root)).includes("pkg"));
    });

    test("deletes a file", async () => {
      await evalOut("_f=open('gone.txt','w'); _f.write('x'); _f.close()");
      assert.ok((await listNames(root)).includes("gone.txt"));

      const res = await com.deleteFiles([rp("gone.txt")]);
      assert.equal(res.type, OperationResultType.commandResult);
      assert.ok(!(await listNames(root)).includes("gone.txt"));
    });

    test("renames a file", async () => {
      await evalOut("_f=open('old.txt','w'); _f.write('x'); _f.close()");

      const res = await com.renameItem(rp("old.txt"), rp("new.txt"));
      assert.equal(res.type, OperationResultType.commandResult);

      const names = await listNames(root);
      assert.ok(names.includes("new.txt"));
      assert.ok(!names.includes("old.txt"));
    });

    test("stats a file and a directory", async () => {
      await evalOut(
        "_f=open('sz.bin','wb'); _f.write(bytes(123)); _f.close()"
      );
      await com.createFolders([rp("adir")]);

      const fileStat = await statOf(rp("sz.bin"));
      assert.equal(fileStat?.isDir, false);
      assert.equal(fileStat?.size, 123);

      const dirStat = await statOf(rp("adir"));
      assert.equal(dirStat?.isDir, true);
    });

    // ---- file transfer --------------------------------------------------

    test("#319: downloads binary data without corruption", async () => {
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
    });

    test("uploads a file to the board", async () => {
      const dir = await mkdtemp(join(tmpdir(), "mpy-up-"));
      try {
        await writeFile(join(dir, "up.py"), "print('hi')\n");
        const res = await com.uploadFiles([join(dir, "up.py")], root, dir);
        assert.equal(res.type, OperationResultType.commandResult);
        assert.ok((await listNames(root)).includes("up.py"));

        const stat = await statOf(rp("up.py"));
        assert.equal(stat?.size, "print('hi')\n".length);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("golden round-trip: upload, list, download, compare", async () => {
      const payloads: Array<{ name: string; bytes: Buffer }> = [
        { name: "hello.txt", bytes: Buffer.from("Hello!\nLine2\n", "utf8") },
        // tricky bytes: NUL, backslash, newline, quote, high bytes, CR
        {
          name: "bin.dat",
          bytes: Buffer.from([
            0x00, 0x01, 0x5c, 0x0a, 0x27, 0x22, 0xe0, 0xff, 0x09, 0x0d,
          ]),
        },
        { name: "rand.bin", bytes: randomBytes(2048) },
      ];

      const src = await mkdtemp(join(tmpdir(), "mpy-src-"));
      const dst = await mkdtemp(join(tmpdir(), "mpy-dst-"));
      try {
        const files: string[] = [];
        for (const { name, bytes } of payloads) {
          const p = join(src, name);
          await writeFile(p, bytes);
          files.push(p);
        }

        const up = await com.uploadFiles(files, root, src);
        assert.equal(up.type, OperationResultType.commandResult);

        const names = await listNames(root);
        for (const { name } of payloads) {
          assert.ok(names.includes(name), `board is missing ${name}`);
        }

        const down = await com.downloadFiles(
          payloads.map(p => p.name),
          dst
        );
        assert.equal(down.type, OperationResultType.commandResult);

        for (const { name, bytes } of payloads) {
          const got = await readFile(join(dst, name));
          assert.deepEqual(
            got,
            bytes,
            `byte mismatch after round-trip for ${name}`
          );
        }
      } finally {
        await rm(src, { recursive: true, force: true });
        await rm(dst, { recursive: true, force: true });
      }
    });

    test("uploads into a subdirectory keeping structure", async () => {
      const src = await mkdtemp(join(tmpdir(), "mpy-tree-"));
      try {
        await mkdir(join(src, "lib"));
        await writeFile(join(src, "lib", "mod.py"), "VALUE = 7\n");

        await com.createFolders([rp("lib")]);
        const res = await com.uploadFiles(
          [join(src, "lib", "mod.py")],
          root,
          src
        );
        assert.equal(res.type, OperationResultType.commandResult);
        assert.ok((await listNames(rp("lib"))).includes("mod.py"));
      } finally {
        await rm(src, { recursive: true, force: true });
      }
    });

    // ---- REPL robustness ------------------------------------------------

    test("falls back to exec when the firmware lacks compile()", async () => {
      // mimic a MICROPY_PY_BUILTINS_COMPILE=0 build (e.g. ESP8266, SAMD21)
      await evalOut(
        "def compile(*a):\n raise NameError(\"name 'compile' isn't defined\")"
      );
      try {
        assert.equal((await evalOut("print(40 + 2)")).trim(), "42");
      } finally {
        await evalOut("del compile");
      }
    });

    test("a SyntaxError raised at runtime runs the line once", async () => {
      await evalOut("_n = 0");
      await evalOut('_n += 1; exec("x y")');
      assert.equal((await evalOut("_n")).trim(), "1");
    });

    // ---- hardware-only --------------------------------------------------

    test("soft reset leaves the board responsive", hardwareOnly, async () => {
      const res = await com.softReset();
      assert.notEqual(res.type, OperationResultType.none);
      assert.match(await evalOut("1 + 1"), /2/);
    });

    // Ctrl-C reaches the Unix port as a plain byte (the PTY is raw, no SIGINT),
    // so interrupt handling is only observable on a real board.
    const swallowedStop = "a second stop ends a program ignoring the first";
    test(swallowedStop, hardwareOnly, async () => {
      // Counts one stop per burst (each stop sends two Ctrl-C) and ends on its
      // own after 8s. The try also covers the loop condition so a trailing
      // Ctrl-C cannot slip past it.
      const program = [
        "import time",
        "_k = 0; _l = 0; _t = time.ticks_ms()",
        "while True:",
        "    try:",
        "        if _k >= 2 or time.ticks_diff(time.ticks_ms(), _t) > 8000:",
        "            break",
        "        time.sleep_ms(20)",
        "    except KeyboardInterrupt:",
        "        if time.ticks_diff(time.ticks_ms(), _l) > 500:",
        "            _k += 1; _l = time.ticks_ms()",
      ].join("\n");

      const started = Date.now();
      const run = evalOut(program);
      await sleep(1000);
      com.interruptExecution();
      await sleep(1000);
      com.interruptExecution();
      await run;

      // ending well before the 8s cap proves the second stop was honoured;
      // not before the second stop proves the first one was swallowed
      const elapsed = Date.now() - started;
      assert.ok(elapsed > 1500, `ended after the first stop (${elapsed}ms)`);
      assert.ok(elapsed < 5000, `second stop was ignored (${elapsed}ms)`);
    });

    const failedHandshake = "releases the port when the handshake fails";
    test(failedHandshake, hardwareOnly, async () => {
      // a program that ignores Ctrl-C keeps the board out of the raw REPL
      const stubborn = [
        "import time",
        "_t = time.ticks_ms()",
        "while time.ticks_diff(time.ticks_ms(), _t) < 20000:",
        "    try:",
        "        time.sleep_ms(20)",
        "    except KeyboardInterrupt:",
        "        pass",
      ].join("\n");
      const started = Date.now();
      void evalOut(stubborn);
      await sleep(1000);
      await com.closeSerialPort(true);

      let portError = false;
      const onError = (): void => {
        portError = true;
      };
      com.on(PicoSerialEvents.portError, onError);
      try {
        await com.openSerialPort(board.port);
        // the handshake gives up after ~10s; previously the port stayed locked
        for (let i = 0; i < 150 && !portError; i++) {
          await sleep(100);
        }
        assert.ok(portError, "no portError after the failed handshake");
        for (let i = 0; i < 30 && !com.isPortDisconnected(); i++) {
          await sleep(100);
        }
        assert.ok(com.isPortDisconnected(), "port still held");
      } finally {
        com.off(PicoSerialEvents.portError, onError);
      }

      // once the program has ended the board must be usable again
      await sleep(Math.max(0, 21000 - (Date.now() - started)));
      await com.openSerialPort(board.port);
      await waitUntilReady();
    });
  }
);
