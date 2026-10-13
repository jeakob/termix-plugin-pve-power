import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
execFileSync("npm", ["test"], { stdio: "inherit" });
const file = `${manifest.id}-${manifest.version}.tmxplug`;
execFileSync("tar", ["-czf", file, "manifest.json", "dist", "locales", "docs", "README.md", "CHANGELOG.md", "LICENSE"], { stdio: "inherit" });
console.log(file);
