/**
 * Opener Service Types
 * Types for opening/revealing files and folders
 */

export interface OpenerService {
  /** `roots`: the user's attached folders the path may sit in; Flint's own
   * data folder is always allowed. The backend enforces it. */
  /** Select the item inside its parent folder. For opening a folder itself, use
   * `openPath` — revealing a directory shows its parent, not its contents. */
  revealItemInDir(path: string, roots?: readonly string[]): Promise<void>
  /** Hand a local path to the OS default application for its type; a folder
   * opens in the file manager. */
  openPath(path: string, roots?: readonly string[]): Promise<void>
  /** Hand an http(s) URL to the OS default browser. */
  openUrl(url: string): Promise<void>
}
