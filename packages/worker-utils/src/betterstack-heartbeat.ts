export async function sendBetterStackHeartbeat(url: string, success: boolean): Promise<void> {
  try {
    await fetch(success ? url : `${url}/fail`);
  } catch {
    // best-effort, never throw
  }
}
