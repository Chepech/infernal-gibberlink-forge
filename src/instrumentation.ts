export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getUploadConfig, sweepExpiredSessions } = await import(
      "./lib/upload-manager"
    );
    const { logInfo, logWarn } = await import("./lib/logger");
    try {
      const config = getUploadConfig();
      const deleted = await sweepExpiredSessions(config.uploadDir);
      if (deleted.length > 0) {
        logInfo("startup.sweep", {
          msg: `Cleaned up ${deleted.length} expired upload session(s) on startup`,
          deleted,
        });
      }
    } catch (err) {
      logWarn("startup.sweep", {
        msg: "Upload sweep on startup failed",
        error: String(err),
      });
    }
  }
}
