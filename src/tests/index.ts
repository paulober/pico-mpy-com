import { PicoMpyCom } from "../picoMpyCom.js";
import { createInterface } from "readline";
import { PicoSerialEvents } from "../picoSerialEvents.js";
import { OperationResultType } from "../operationResult.js";

const serialCom = PicoMpyCom.getInstance();

// get available serial ports
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

interface Command {
  aliases: string[];
  description: string;
}

const commands: Record<string, Command> = {
  help: {
    aliases: ["h", "help"],
    description: "Shows this help message.",
  },
  list: {
    aliases: ["l", "list"],
    description: "Lists available serial ports.",
  },
  open: {
    aliases: ["o", "open"],
    description: "Opens a serial port connection.",
  },
  close: {
    aliases: ["c", "close"],
    description: "Closes the serial port connection.",
  },
  helloWorld: {
    aliases: ["hw", "hello"],
    description: "Sends a hello world command.",
  },
  listContents: {
    aliases: ["lc", "listContents"],
    description: "Lists the contents of a directory.",
  },
  downloadFiles: {
    aliases: ["dl", "download"],
    description: "Downloads files from the board.",
  },
  uploadFiles: {
    aliases: ["ul", "upload"],
    description: "Uploads files to the board.",
  },
  runFile: {
    aliases: ["rf", "run"],
    description: "Runs a local file on the board.",
  },
  getRtcTime: {
    aliases: ["grt", "getRtcTime"],
    description: "Gets the real-time clock time from the board.",
  },
  syncRtc: {
    aliases: ["sync", "syncRtc"],
    description: "Synchronizes the real-time clock with the system time.",
  },
  executeCommandWithResut: {
    aliases: ["ecr", "execute"],
    description: "Executes a command and waits for the result.",
  },
  exit: {
    aliases: ["e", "exit"],
    description: "Exits the program.",
  },
};

serialCom.on(PicoSerialEvents.portOpened, () => {
  console.log("\x1b[32mSuccessfully connected to the board.\x1b[0m\n");
  rl.prompt();
  rl.resume();
});

serialCom.on(PicoSerialEvents.portClosed, () => {
  console.log("\x1b[31mThe board has been disconnected.\x1b[0m");
  rl.prompt();
  rl.resume();
});

serialCom.on(PicoSerialEvents.portError, error => {
  console.error(`${error}`);
  rl.prompt();
  rl.resume();
});

let relayInput = false;

async function handleCommand(command: string): Promise<void> {
  switch (command) {
    case "help":
    case "h":
      console.log("Available commands:");
      for (const [name, cmd] of Object.entries(commands)) {
        console.log(
          `- ${name} (${cmd.aliases.join(", ")}): ${cmd.description}`
        );
      }
      break;
    case "list":
    case "l":
      {
        const ports = await PicoMpyCom.getSerialPorts();
        console.log("Available serial ports:");
        for (const port of ports) {
          console.log(`- ${port}`);
        }
      }
      break;

    case "open":
    case "o":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the port to open: ", port => {
          rl.pause();
          void serialCom
            .openSerialPort(port)
            .catch(error => {
              reject(
                error instanceof Error
                  ? error
                  : typeof error === "string"
                  ? new Error(error)
                  : new Error("Unknown error")
              );
            })
            .then(resolve);
        });
      });
      break;

    case "close":
    case "c":
      console.log("Closing port...");
      await serialCom.closeSerialPort();
      console.log("Port closed.");
      break;

    case "helloWorld":
    case "hw":
      {
        rl.pause();
        const data = await serialCom.helloWorld();
        console.log(
          data.type === OperationResultType.commandResponse
            ? data.response
            : data.type === OperationResultType.none
            ? "No board connected"
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "listContents":
    case "lc":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the directory to list: ", directory => {
          rl.pause();
          serialCom
            .listContents(directory)
            .then(data => {
              if (data.type === OperationResultType.listContents) {
                console.log("Contents:");
                for (const item of data.contents) {
                  console.log(`- ${item.path} (${item.size} bytes)`);
                }
              } else {
                console.error("Error listing contents.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      rl.prompt();
      rl.resume();
      break;

    case "downloadFiles":
    case "dl":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the files to download: ", files => {
          rl.question(
            "Enter the local directory to save the files: ",
            local => {
              rl.pause();
              serialCom
                .downloadFiles(files.split(" "), local)
                .then(() => {
                  console.log("Files downloaded successfully.");
                  resolve();
                })
                .catch(reject);
            }
          );
        });
      });
      break;

    case "uploadFiles":
    case "ul":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the files to upload: ", files => {
          rl.question(
            "Enter the remote directory to save the files: ",
            remote => {
              rl.pause();
              serialCom
                .uploadFiles(files.split(" "), remote)
                .then(() => {
                  console.log("Files uploaded successfully.");
                  resolve();
                })
                .catch(reject);
            }
          );
        });
      });
      break;

    case "runFile":
    case "rf":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the file to run: ", file => {
          rl.pause();
          serialCom
            .runFile(
              file,
              (open: boolean) => {
                if (open) {
                  relayInput = true;
                  rl.resume();
                }
              },
              (data: Buffer) => {
                process.stdout.write(data);
              }
            )
            .then(() => {
              relayInput = false;
              console.log("File executed successfully.");
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "getRtcTime":
    case "grt":
      {
        rl.pause();
        const data = await serialCom.getRtcTime();
        console.log(
          data.type === OperationResultType.getRtcTime
            ? data.time?.toString() ?? "No time received."
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "syncRtc":
    case "sync":
      {
        rl.pause();
        const data = await serialCom.syncRtcTime();
        console.log(
          data.type === OperationResultType.status
            ? data.status
              ? "RTC synchronized successfully."
              : "RTC synchronization failed."
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "exit":
    case "e":
      process.exit(0);
      break;

    default:
      console.log(
        `Unknown command '${command}'. Type 'h' or 'help' ` +
          "for a list of available commands."
      );
      break;
  }
}

console.log(
  "⚠️ \x1b[31m%s\x1b[0m 🧪\n",
  "Pico Serial Communication Testing Terminal (experimental)"
);

handleCommand("help")
  .then(() => {
    console.log("Type 'h' or 'help' for a list of available commands.\n");
    rl.prompt();

    rl.on("line", line => {
      if (relayInput) {
        serialCom.emit(
          PicoSerialEvents.relayInput,
          Buffer.from(line + "\r\n", "utf-8")
        );

        return;
      }
      handleCommand(line.trim())
        .then(() => rl.prompt())
        .catch(console.error);
    }).on("close", () => {
      console.log("Exiting program.");
      process.exit(0);
    });
  })
  .catch(console.error);
