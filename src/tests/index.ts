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
  listContentsRecursive: {
    aliases: ["lcr", "listContentsRecursive"],
    description: "Lists the contents of a directory recursively.",
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
  clearFs: {
    aliases: ["cfs", "clearFs"],
    description: "Clears the file system.",
  },
  uploadProject: {
    aliases: ["up", "uploadProject"],
    description: "Uploads a project to the board.",
  },
  downlaodProject: {
    aliases: ["dp", "downloadProject"],
    description: "Downloads a project from the board.",
  },
  retrieveTabComp: {
    aliases: ["tc", "tabComp"],
    description: "Retrieves tab completion suggestions.",
  },
  getItemStat: {
    aliases: ["gis", "getItemStat"],
    description: "Gets the status of a file or directory.",
  },
  rename: {
    aliases: ["rn", "rename"],
    description: "Renames a file or directory.",
  },
  softReset: {
    aliases: ["sr", "softReset"],
    description: "Performs a soft reset.",
  },
  ctrlD: {
    aliases: ["cd", "ctrlD"],
    description: "Sends a Ctrl+D command.",
  },
  deleteFiles: {
    aliases: ["dfi", "deleteFiles"],
    description: "Deletes files from the board.",
  },
  createFolders: {
    aliases: ["cfo", "createFolders"],
    description: "Creates folders on the board.",
  },
  deleteFolders: {
    aliases: ["dfo", "deleteFolders"],
    description: "Deletes folders on the board.",
  },
  deleteFolderRecursive: {
    aliases: ["dfor", "deleteFolderRecursive"],
    description: "Deletes a folder on the board recursively.",
  },
  deleteFileOrFolderRecursive: {
    aliases: ["dfr", "deleteFileOrFolderRecursive"],
    description: "Deletes a file or folder on the board recursively.",
  },
  executeFriendlyCommand: {
    aliases: ["efc", "execute"],
    description: "Executes a command and waits for the result.",
  },
  hardReset: {
    aliases: ["hr", "hardReset"],
    description: "Performs a hard reset.",
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

    case "listContentsRecursive":
    case "lcr":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the directory to list recursively: ", directory => {
          rl.pause();
          serialCom
            .listContentsRecursive(directory)
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
                .downloadFiles(
                  files.split(" "),
                  local,
                  (total: number, current: number, path: string) => {
                    console.log(`Uploading ${current}/${total} - ${path}`);
                  }
                )
                .then(result => {
                  if (result.type === OperationResultType.commandResult) {
                    console.log(
                      result.result
                        ? "Files downloaded successfully."
                        : "Files download failed."
                    );
                  }
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
                .uploadFiles(
                  files.split(" "),
                  remote,
                  undefined,
                  (total: number, current: number, path: string) => {
                    console.log(`Uploading ${current}/${total} - ${path}`);
                  }
                )
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
          data.type === OperationResultType.commandResult
            ? data.result
              ? "RTC synchronized successfully."
              : "RTC synchronization failed."
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "clearFs":
    case "cfs":
      {
        rl.pause();
        const data = await serialCom.deleteFolderRecursive("/");
        console.log(
          data.type === OperationResultType.commandResult
            ? data.result
              ? "File system cleared successfully."
              : "File system clearing failed."
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "uploadProject":
    case "up":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the project folder: ", projectFolder => {
          rl.question(
            "Enter the file types to upload (none means all): ",
            fileTypes => {
              rl.question(
                // eslint-disable-next-line max-len
                "Enter the ignored items (paths relative to the project folder): ",
                ignoredItems => {
                  rl.question(
                    // eslint-disable-next-line max-len
                    "Do you want to interrupt after a certain number of chunks? (0 for no): ",
                    interruptAfterChunks => {
                      rl.pause();
                      const interruptAfterChunksNum =
                        parseInt(interruptAfterChunks);
                      serialCom
                        .uploadProject(
                          projectFolder,
                          fileTypes.split(" ").filter(item => item.length > 0),
                          ignoredItems
                            .split(" ")
                            .filter(item => item.length > 0),
                          (total: number, current: number, path: string) => {
                            if (
                              interruptAfterChunksNum > 0 &&
                              current >= interruptAfterChunksNum
                            ) {
                              setImmediate(
                                serialCom.interruptExecution.bind(serialCom)
                              );
                            }
                            console.log(
                              `Uploading ${current}/${total} - ${path}`
                            );
                          }
                        )
                        .then(data => {
                          if (data.type === OperationResultType.commandResult) {
                            console.log(
                              data.result
                                ? "Project uploaded successfully."
                                : "Project upload failed."
                            );
                          }
                          resolve();
                        })
                        .catch(reject);
                    }
                  );
                }
              );
            }
          );
        });
      });
      break;

    case "downlaodProject":
    case "dp":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the local folder to save the project: ", local => {
          rl.question("Enter the remote folder to download from: ", remote => {
            rl.question(
              "Enter the file types to download (none means all): ",
              fileTypes => {
                rl.question("Enter the ignored items: ", ignoredItems => {
                  rl.pause();
                  serialCom
                    .downloadProject(
                      local,
                      remote,
                      fileTypes.split(" ").filter(item => item.length > 0),
                      ignoredItems.split(" ").filter(item => item.length > 0),
                      (total: number, current: number, path: string) => {
                        console.log(
                          `Downloading ${current}/${total} - ${path}`
                        );
                      }
                    )
                    .then(data => {
                      if (data.type === OperationResultType.commandResult) {
                        console.log(
                          data.result
                            ? "Project downloaded successfully."
                            : "Project download failed."
                        );
                      }
                      resolve();
                    })
                    .catch(reject);
                });
              }
            );
          });
        });
      });
      break;

    case "tabComplete":
    case "tc":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the code to complete: ", code => {
          rl.pause();
          serialCom
            .retrieveTabCompletion(code)
            .then(data => {
              if (data.type === OperationResultType.tabComplete) {
                console.log("Suggestions:");
                console.log(data.suggestions);
              } else {
                console.error("Error retrieving suggestions.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "execute":
    case "efc":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the command to execute: ", command => {
          rl.pause();
          serialCom
            .runFriendlyCommand(
              command,
              (open: boolean) => {
                if (open) {
                  relayInput = true;
                  rl.resume();
                }
              },
              (data: Buffer) => {
                process.stdout.write(data);
              },
              "python"
            )
            .then(data => {
              relayInput = false;
              if (data.type === OperationResultType.commandResult) {
                console.log(
                  data.result
                    ? "Command executed successfully."
                    : "Command failed."
                );
              } else {
                console.error("Error executing command.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "getItemStat":
    case "gis":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the item to get the status of: ", item => {
          rl.pause();
          serialCom
            .getItemStat(item)
            .then(data => {
              if (data.type === OperationResultType.getItemStat && data.stat) {
                console.log(
                  `Item: ${item}\n` +
                    `Is directory: ${data.stat.isDir}\n` +
                    `Size: ${data.stat.size} bytes\n` +
                    `Last modified: ${
                      data.stat.lastModified?.toString() ?? "N/A"
                    }\n`,
                  `Created: ${data.stat.created?.toString() ?? "N/A"}`
                );
              } else {
                console.error("Error getting item status.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "rename":
    case "rn":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the item to rename: ", item => {
          rl.question("Enter the new name: ", newName => {
            rl.pause();
            serialCom
              .renameItem(item, newName)
              .then(data => {
                if (data.type === OperationResultType.commandResult) {
                  console.log(
                    data.result
                      ? "Item renamed successfully."
                      : "Item renaming failed."
                  );
                } else {
                  console.error("Error renaming item.");
                }
                resolve();
              })
              .catch(reject);
          });
        });
      });
      break;

    case "softReset":
    case "sr":
      {
        rl.pause();
        const data = await serialCom.softReset();
        console.log(
          data.type === OperationResultType.commandResult
            ? data.result
              ? "Board reset successfully."
              : "Board reset failed."
            : "Invalid response."
        );
        rl.prompt();
        rl.resume();
      }
      break;

    case "ctrlD":
    case "cd":
      {
        rl.pause();
        const data = await serialCom.sendCtrlD(
          (open: boolean) => {
            if (open) {
              relayInput = true;
              rl.resume();
            }
          },
          (data: Buffer) => {
            process.stdout.write(data);
          }
        );
        relayInput = false;
        if (data.type === OperationResultType.commandResult) {
          console.log(
            data.result ? "Ctrl+D sent successfully." : "Ctrl+D sending failed."
          );
        } else {
          console.error("Invalid response.");
        }
        rl.prompt();
        rl.resume();
      }
      break;

    // TODO: add delete commands
    case "deleteFiles":
    case "dfi":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the files to delete: ", files => {
          rl.pause();
          serialCom
            .deleteFiles(files.split(" "))
            .then(data => {
              if (data.type === OperationResultType.commandResult) {
                console.log(
                  data.result
                    ? "Files deleted successfully."
                    : "Files deletion failed."
                );
              } else {
                console.error("Error deleting files.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "createFolders":
    case "cfo":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the folders to create: ", folders => {
          rl.pause();
          serialCom
            .createFolders(folders.split(" "))
            .then(data => {
              if (data.type === OperationResultType.commandResult) {
                console.log(
                  data.result
                    ? "Folders created successfully."
                    : "Folders creation failed."
                );
              } else {
                console.error("Error creating folders.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "deleteFolders":
    case "dfo":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the folders to delete: ", folders => {
          rl.pause();
          serialCom
            .deleteFolders(folders.split(" "))
            .then(data => {
              if (data.type === OperationResultType.commandResult) {
                console.log(
                  data.result
                    ? "Folders deleted successfully."
                    : "Folders deletion failed."
                );
              } else {
                console.error("Error deleting folders.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "deleteFolderRecursive":
    case "dfor":
      await new Promise<void>((resolve, reject) => {
        rl.question("Enter the folder to delete recursively: ", folder => {
          rl.pause();
          serialCom
            .deleteFolderRecursive(folder)
            .then(data => {
              if (data.type === OperationResultType.commandResult) {
                console.log(
                  data.result
                    ? "Folder deleted successfully."
                    : "Folder deletion failed."
                );
              } else {
                console.error("Error deleting folder.");
              }
              resolve();
            })
            .catch(reject);
        });
      });
      break;

    case "deleteFileOrFolderRecursive":
    case "dfr":
      await new Promise<void>((resolve, reject) => {
        rl.question(
          "Enter the file or folder to delete recursively: ",
          item => {
            rl.pause();
            serialCom
              .deleteFileOrFolder(item, true)
              .then(data => {
                if (data.type === OperationResultType.commandResult) {
                  console.log(
                    data.result
                      ? "Item deleted successfully."
                      : "Item deletion failed."
                  );
                } else {
                  console.error("Error deleting item.");
                }
                resolve();
              })
              .catch(reject);
          }
        );
      });
      break;

    case "hardReset":
    case "hr":
      {
        // TODO: test and fix hardreset
        rl.pause();
        const data = await serialCom.hardReset();
        console.log(
          data.type === OperationResultType.commandResult
            ? data.result
              ? "Board reset successfully."
              : "Board reset failed."
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
          Buffer.from(line.trim(), "utf-8")
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
