#!/usr/bin/env node

// scripts/launcher.js
// Process launcher for TeleTopaz hot-restart support.
// Monitors the child process exit code: exit(75) triggers a rebuild + restart cycle.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const EXIT_CODE_RESTART = 75;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function timestamp() {
  return new Date().toISOString();
}

function runBuild() {
  return new Promise((resolve, reject) => {
    console.log(`[${timestamp()}] [launcher] 🔨 Building project...`);
    const child = spawn("npm", ["run", "build"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[${timestamp()}] [launcher] ✅ Build succeeded.`);
        resolve(undefined);
      } else {
        reject(new Error(`Build failed with exit code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

function runBot() {
  return new Promise((resolve) => {
    console.log(`[${timestamp()}] [launcher] 🚀 Starting bot process...`);
    const child = spawn("node", ["dist/index.js"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    });

    // Forward signals to child
    const forwardSignal = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // child may have already exited
      }
    };
    process.on("SIGINT", () => forwardSignal("SIGINT"));
    process.on("SIGTERM", () => forwardSignal("SIGTERM"));

    child.on("close", (code) => {
      resolve(code ?? 1);
    });

    child.on("error", (err) => {
      console.error(`[${timestamp()}] [launcher] ❌ Failed to start bot:`, err.message);
      resolve(1);
    });
  });
}

async function main() {
  console.log(`[${timestamp()}] [launcher] 🟢 TeleTopaz Launcher started.`);

  while (true) {
    try {
      await runBuild();
    } catch (err) {
      console.error(`[${timestamp()}] [launcher] ❌ ${err.message}`);
      process.exit(1);
    }

    const exitCode = await runBot();

    if (exitCode === EXIT_CODE_RESTART) {
      console.log(`[${timestamp()}] [launcher] 🔄 Restart requested (exit code ${EXIT_CODE_RESTART}). Rebuilding...`);
      continue;
    }

    if (exitCode === 0) {
      console.log(`[${timestamp()}] [launcher] 🛑 Bot exited normally.`);
      process.exit(0);
    }

    console.error(`[${timestamp()}] [launcher] ❌ Bot exited with code ${exitCode}.`);
    process.exit(exitCode);
  }
}

main();
