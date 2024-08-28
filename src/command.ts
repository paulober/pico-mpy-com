export enum CommandType {
  command,
  expression,
  tabComplete,
  runFile,
  doubleCtrlC,
  listContents,
  listContentsRecursive,
  uploadFiles,
  downloadFiles,
  deleteFiles,
  mkdirs,
  rmdirs,
  rmtree,
  rmFileOrDir,
  uploadProject,
  getItemStat,
  rename,
  syncRtc,
  getRtcTime,
  softReset,
  hardReset,
  ctrlD,
  factoryResetFilesystem,
}

// TODO: it should not be possible to have every command type also accept args = {}
interface CommandArgsMapping {
  [CommandType.command]: { command: string; interactive?: boolean };
  [CommandType.expression]: { code: string };
  [CommandType.tabComplete]: { code: string };
  [CommandType.runFile]: { files: string[] };
  [CommandType.doubleCtrlC]: object;
  [CommandType.listContents]: { target: string };
  [CommandType.listContentsRecursive]: { target: string };
  [CommandType.downloadFiles]: {
    files: string[];
    local: string;
    verbose?: boolean;
  };
  [CommandType.uploadFiles]: {
    files: string[];
    remote: string;
    localBaseDir?: string;
    verbose?: boolean;
  };
  [CommandType.deleteFiles]: { files: string[] };
  [CommandType.mkdirs]: { folders: string[] };
  [CommandType.rmdirs]: { folders: string[] };
  [CommandType.rmtree]: { folders: string[] };
  [CommandType.rmFileOrDir]: { target: string; recursive?: boolean };
  [CommandType.uploadProject]: {
    projectFolder: string;
    fileTypes: string[];
    ignoredItems: string[];
  };
  [CommandType.rename]: { item: string; target: string };
  [CommandType.getItemStat]: { item: string };
  [CommandType.syncRtc]: object;
  [CommandType.getRtcTime]: object;
  [CommandType.softReset]: object;
  [CommandType.hardReset]: { verbose?: boolean };
  [CommandType.ctrlD]: object;
  [CommandType.factoryResetFilesystem]: object;
}

type RequiredArgs<T extends CommandType> = CommandArgsMapping[T];

export interface Command<T extends CommandType = CommandType> {
  type: T;
  args: RequiredArgs<T>;
  /*  & {
    // Additional optional arguments that are not required but available for every command
  }; */
}
