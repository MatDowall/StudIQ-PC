import { useCallback, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateCheckState =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error";

export function useUpdateChecker() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [state, setState] = useState<UpdateCheckState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const checkForUpdate = useCallback(async () => {
    setState("checking");
    setError(null);
    try {
      const result = await check();
      if (result) {
        setUpdate(result);
        setState("available");
      } else {
        setUpdate(null);
        setState("up-to-date");
      }
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }, []);

  const installUpdate = useCallback(async () => {
    if (!update) return;
    setState("downloading");
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            setProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
            break;
          case "Finished":
            setState("ready");
            break;
        }
      });
      await relaunch();
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }, [update]);

  return { update, state, progress, error, checkForUpdate, installUpdate };
}
