import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SerialPort } from "serialport";

/**
 * A MicroPython board to run integration tests against. Either a real device
 * (when MICROPICO_TEST_PORT is set) or a simulator: the MicroPython Unix port
 * bridged to a PTY via socat, which speaks the exact same raw-REPL protocol,
 * so the library's real code paths are exercised without any hardware.
 */
export interface TestBoard {
  /** Serial port path the library should open. */
  readonly port: string;
  /**
   * Absolute path that acts as the board's filesystem root. On real hardware
   * this is "/"; on the Unix-port simulator "/" is the host root, so the board
   * root is the interpreter's working directory instead. The REPL's current
   * working directory always equals this root, so relative paths resolve here
   * on both targets.
   */
  readonly root: string;
  /** Tear down the board (kill the simulator, remove temp files). */
  dispose(): Promise<void>;
}

function hasTool(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

/** Whether the simulator backend (micropython + socat) is available. */
export function simulatorAvailable(): boolean {
  return hasTool("micropython") && hasTool("socat");
}

/** Whether integration tests can run at all (real board or simulator). */
export function integrationBoardAvailable(): boolean {
  return (
    process.env.MICROPICO_TEST_PORT !== undefined || simulatorAvailable()
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Raw, bounded sanity handshake against the simulator PTY that mirrors exactly
 * what the library's connect path expects: a friendly `>>>` prompt, then
 * CTRL-A must yield the raw-REPL banner. A backend that cannot do this (wrong
 * micropython build/version) fails here in seconds — with the raw bytes it did
 * send — instead of hanging the library's operation queue for the whole job.
 */
async function assertReplResponds(
  port: string,
  timeoutMs: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sp = new SerialPort({ path: port, baudRate: 115200, autoOpen: true });
    let buf = "";
    let phase: "prompt" | "raw" = "prompt";

    const finish = (err?: Error): void => {
      clearTimeout(timer);
      sp.removeAllListeners();
      sp.close(() => (err ? reject(err) : resolve()));
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `simulator REPL handshake stalled in phase '${phase}' after ` +
              `${timeoutMs}ms; raw output: ${JSON.stringify(buf)}`
          )
        ),
      timeoutMs
    );

    sp.on("error", e => finish(e));
    sp.on("open", () => sp.write("\r\x03\x03\r"));
    sp.on("data", d => {
      buf += d.toString("latin1");
      if (phase === "prompt" && buf.includes(">>>")) {
        phase = "raw";
        buf = "";
        sp.write("\x01"); // CTRL-A → raw REPL, exactly what enterRawRepl sends
      } else if (phase === "raw" && buf.includes("raw REPL; CTRL-B to exit")) {
        sp.write("\x02", () => finish()); // CTRL-B: leave a clean friendly REPL
      }
    });
  });
}

/**
 * Acquire a test board. Prefers a real device via MICROPICO_TEST_PORT; falls
 * back to spawning the MicroPython Unix simulator over a PTY.
 */
export async function getTestBoard(): Promise<TestBoard> {
  const envPort = process.env.MICROPICO_TEST_PORT;
  if (envPort !== undefined) {
    return { port: envPort, root: "/", dispose: () => Promise.resolve() };
  }

  // Log the backend version once so CI failures are diagnosable at a glance.
  try {
    const version = execSync("micropython --version 2>&1").toString().trim();
    console.log(`# [itest] simulator backend: ${version}`);
  } catch {
    // best-effort diagnostic only
  }

  // temp layout: <dir>/pty (the PTY link) + <dir>/board (the board filesystem).
  // The PTY lives OUTSIDE the board dir so it never shows up in os.listdir().
  const dir = await mkdtemp(join(tmpdir(), "mpy-sim-"));
  const boardDir = join(dir, "board");
  await mkdir(boardDir, { recursive: true });
  const pty = join(dir, "pty");

  const socat: ChildProcess = spawn(
    "socat",
    [`PTY,link=${pty},raw,echo=0`, "EXEC:micropython,pty,raw,echo=0"],
    { cwd: boardDir, stdio: "ignore" }
  );

  for (let i = 0; i < 50 && !existsSync(pty); i++) {
    await sleep(100);
  }
  if (!existsSync(pty)) {
    socat.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    throw new Error("simulator PTY did not appear (is socat/micropython ok?)");
  }

  // Fail fast (with diagnostics) if the REPL behind the PTY does not actually
  // speak the raw-REPL protocol, rather than letting every test hang later.
  try {
    await assertReplResponds(pty, 15000);
  } catch (err) {
    socat.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  return {
    port: pty,
    // micropython runs with boardDir as its cwd, and "/" would be the host
    // root — so the board's filesystem root is boardDir.
    root: boardDir,
    async dispose(): Promise<void> {
      socat.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    },
  };
}
