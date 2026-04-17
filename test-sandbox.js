import { spawn } from "node:child_process";
const p = spawn("git", ["--no-pager", "status", "--short", "--branch"]);
p.on("error", (err) => console.error("Error:", err));
p.stdout.on("data", (d) => process.stdout.write(d));
p.stderr.on("data", (d) => process.stderr.write(d));
