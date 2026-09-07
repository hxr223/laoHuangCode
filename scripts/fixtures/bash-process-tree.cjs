const { spawn } = require("node:child_process");

if (process.argv[2] === "worker") {
  setTimeout(() => {}, 10000);
} else {
  const child = spawn(process.execPath, [__filename, "worker"], { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("spawn", () => {
    console.log(`worker:${child.pid}`);
    if (process.argv[2] === "exit") {
      child.unref();
      process.exit(0);
    }
  });
}
