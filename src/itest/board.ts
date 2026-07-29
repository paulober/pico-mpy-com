import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * A MicroPython board to run integration tests against. Either a real device
 * (when MICROPICO_TEST_PORT is set) or a simulator: the MicroPython Unix port
 * bridged to a PTY via socat, which speaks the exact same raw-REPL protocol,
 * so the library's real code paths are exercised without any hardware.
 */
export interface TestBoard {
  /** Serial port path the library should open. */
  readonly port: string;
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
 * Acquire a test board. Prefers a real device via MICROPICO_TEST_PORT; falls
 * back to spawning the MicroPython Unix simulator over a PTY.
 */
export async function getTestBoard(): Promise<TestBoard> {
  const envPort = process.env.MICROPICO_TEST_PORT;
  if (envPort !== undefined) {
    return { port: envPort, dispose: () => Promise.resolve() };
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

  return {
    port: pty,
    async dispose(): Promise<void> {
      socat.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    },
  };
}
