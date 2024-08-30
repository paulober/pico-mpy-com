/**
 * A model for representing file meta data / details on the board.
 */
export default interface FileData {
  /**
   * The path of the file on the device
   */
  path: string;
  /**
   * Is Directory
   */
  isDir: boolean;
  /**
   * The size of the file in bytes
   */
  size: number;

  /**
   * The last modified date of the file
   * @type {Date}
   * @memberof PyFileData
   * @example
   */
  lastModified?: Date;

  /**
   * The creation date of the file
   * @type {Date}
   * @memberof PyFileData
   */
  created?: Date;
}

/**
 * The result of a rename operation sent from the board. (DTO)
 */
export interface RenameResult {
  /**
   * Operation result
   */
  success: boolean;
  /**
   * Error message
   * @type {string}
   * @memberof RenameResult
   */
  error?: string;
}
