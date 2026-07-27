/** localStorage-backed transcript view preferences (message format, hide-tools). Reads and writes are
 * guarded because storage can be unavailable (private mode, disabled cookies) - the defaults apply. */
import type { MsgFormat } from "./contexts";

const FORMAT_KEY = "agentlens.msgFormat";

export function loadFormat(): MsgFormat {
  try {
    return localStorage.getItem(FORMAT_KEY) === "raw" ? "raw" : "markdown";
  } catch {
    return "markdown";
  }
}

const HIDE_TOOLS_KEY = "agentlens.hideTools";

export function loadHideTools(): boolean {
  try {
    return localStorage.getItem(HIDE_TOOLS_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveFormat(f: MsgFormat): void {
  try {
    localStorage.setItem(FORMAT_KEY, f);
  } catch {
    /* ignore unavailable storage */
  }
}

export function saveHideTools(hide: boolean): void {
  try {
    localStorage.setItem(HIDE_TOOLS_KEY, hide ? "1" : "0");
  } catch {
    /* ignore unavailable storage */
  }
}
