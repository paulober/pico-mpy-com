import type FileData from "./fileData.js";

export enum OperationResultType {
  none,
  commandResponse,
  commandResult,
  listContents,
  getItemStat,
  getRtcTime,
  tabComplete,
}

export type OperationResult =
  | OpResultNone
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
