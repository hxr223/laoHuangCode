const sqliteWarning = "SQLite is an experimental feature and might change at any time";

// SQLite can queue its warning while ESM dependencies load, before this module
// runs. Filter at dispatch rather than emitWarning so queued warnings are covered.
// This is CLI-only: do not alter shared libraries, NODE_OPTIONS or child processes.
process.emit = new Proxy(process.emit, {
  apply(target, receiver: unknown, args: unknown[]) {
    const [event, warning] = args;
    if (event === "warning" && warning instanceof Error
      && warning.name === "ExperimentalWarning" && warning.message === sqliteWarning
      && !("code" in warning)) {
      return false;
    }
    return Reflect.apply(target, receiver, args);
  },
});
