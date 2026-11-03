import assert from "node:assert/strict";
import test from "node:test";
import * as codeMode from "@laohuang/codemode";

test("tool declarations describe JSON inputs and outputs without expanding recursive references", () => {
  const inputSchema = { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "integer" } } };
  const tool = { name: "read", description: "read data", inputSchema, outputSchema: { type: "string" }, execute: () => "" };
  const declarations = codeMode.renderDeclarations({ tools: [tool] });
  assert.match(declarations, /read\(args:/);
  assert.match(declarations, /path: string/);
  assert.match(declarations, /limit\?: number/);
  assert.match(declarations, /Promise<string>/);
  assert.match(codeMode.renderToolSample(tool), /Promise<string>/);
  for (const [schema, expected] of [
    [true, "unknown"], [false, "never"], [{ type: "array", items: { type: "number" } }, "Array<number>"],
    [{ anyOf: [{ type: "string" }, { type: "null" }] }, "string | null"],
    [{ $defs: { x: { type: "boolean" } }, $ref: "#/$defs/x" }, "boolean"],
    [{ $ref: "#" }, "unknown"], [{ $ref: "https://example.com/schema" }, "unknown"],
  ]) assert.equal(codeMode.schemaToType(schema), expected);
  assert.equal(codeMode.schemaToType(inputSchema, { maxChars: 5 }), "unknown");
});
