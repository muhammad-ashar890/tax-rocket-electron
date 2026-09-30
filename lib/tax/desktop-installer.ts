import fs from "fs";
import path from "path";

export function findDesktopInstallerPath(): string | null {
  const envPath = process.env.TAXROCKET_AGENT_INSTALLER_PATH?.trim();
  if (envPath && fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    return envPath;
  }

  const distDir = path.join(process.cwd(), "electron-connect", "dist");
  if (!fs.existsSync(distDir)) {
    return null;
  }

  const exes = fs
    .readdirSync(distDir)
    .filter((name) => name.toLowerCase().endsWith(".exe"))
    .map((name) => {
      const full = path.join(distDir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return exes[0]?.full ?? null;
}

export function installerDownloadName(filePath: string): string {
  return path.basename(filePath) || "TaxRocket-Portal-Agent-Setup.exe";
}
