import { chmod, copyFile, mkdir, readdir, stat } from "node:fs/promises";

const sourceDir = "src/server/paperclip-transcript-plugin";
const targetDir = "dist/server/paperclip-transcript-plugin";

async function chmodIfAllowed(path, mode) {
  try {
    await chmod(path, mode);
  } catch (err) {
    if (err?.code !== "EPERM" && err?.code !== "EACCES") {
      throw err;
    }
  }
}

async function chmodTree(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    await chmodIfAllowed(path, 0o2775);
    for (const entry of await readdir(path)) {
      await chmodTree(`${path}/${entry}`);
    }
    return;
  }
  if (info.isFile()) {
    await chmodIfAllowed(path, 0o664);
  }
}

await mkdir(targetDir, { recursive: true });
await copyFile(`${sourceDir}/plugin.yaml`, `${targetDir}/plugin.yaml`);
await copyFile(`${sourceDir}/__init__.py`, `${targetDir}/__init__.py`);
await chmodTree("dist");
