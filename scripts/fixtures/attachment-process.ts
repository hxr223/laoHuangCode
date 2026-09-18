import { LocalAttachmentStore } from "@laohuang/attachment-local";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const store = new LocalAttachmentStore({ root: process.argv[2]! });
const release = store.protect();
writeFileSync(join(store.root, "tmp", "11111111-1111-1111-1111-111111111111"), "interrupted staging");
process.send?.("ready");
process.on("message", () => { release(); store.close(); process.exit(0); });
