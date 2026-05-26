import { copyFile, mkdir } from "node:fs/promises";

const sourceDir = "src/server/paperclip-transcript-plugin";
const targetDir = "dist/server/paperclip-transcript-plugin";

await mkdir(targetDir, { recursive: true });
await copyFile(`${sourceDir}/plugin.yaml`, `${targetDir}/plugin.yaml`);
await copyFile(`${sourceDir}/__init__.py`, `${targetDir}/__init__.py`);
