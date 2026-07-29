import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PicoMpyCom } from "../picoMpyCom.js";
import { OperationResultType } from "../operationResult.js";
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

describe(
  "integration: core board operations",
  {
    skip: integrationBoardAvailable()
      ? false
      : "no board and no simulator (install micropython + socat)",
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

    // ---- hardware-only --------------------------------------------------

    test("soft reset leaves the board responsive", hardwareOnly, async () => {
      const res = await com.softReset();
      assert.notEqual(res.type, OperationResultType.none);
      assert.match(await evalOut("1 + 1"), /2/);
    });
  }
);
