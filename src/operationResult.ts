import type FileData from "./fileData.js";

export enum OperationResultType {
  none,
  status,
  commandResponse,
  commandResult,
  listContents,
  getItemStat,
  getRtcTime,
  tabComplete,
}

export type OperationResult =
  | OpResultNone
  | OpResultStatus
  | OpResultCommandResponse
  | OpResultCommandResult
  | OpResultListContents
  | OpResultGetItemStat
  | OpResultGetRtcTime
  | OpResultTabComplete;

interface OpResult {
  type: OperationResultType;
}

export interface OpResultNone extends OpResult {
  type: OperationResultType.none;
}

export interface OpResultStatus extends OpResult {
  type: OperationResultType.status;
  status: boolean;
}

export interface OpResultCommandResponse extends OpResult {
  type: OperationResultType.commandResponse;
  response: string;
}

export interface OpResultCommandResult extends OpResult {
  type: OperationResultType.commandResult;
  result: boolean;
}

export interface OpResultListContents extends OpResult {
  type: OperationResultType.listContents;
  contents: FileData[];
}

export interface OpResultGetItemStat extends OpResult {
  type: OperationResultType.getItemStat;
  stat: FileData | null;
}

export interface OpResultGetRtcTime extends OpResult {
  type: OperationResultType.getRtcTime;
  time: Date | null;
}

export interface OpResultTabComplete extends OpResult {
  type: OperationResultType.tabComplete;
  isSimple: boolean;
  suggestions: string;
}
