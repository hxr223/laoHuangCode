import assert from "node:assert/strict";
import test from "node:test";
import * as codeMode from "@laohuang/codemode";

test("first-line options are parsed without changing JavaScript line numbers", () => {
  assert.deepEqual(codeMode.parseCodeModeSource('// @options: {"timeout_ms":20,"max_output_tokens":0}\nreturn 1;'),
    { code: "\nreturn 1;", options: { timeoutMs: 20, maxOutputTokens: 0 } });
  assert.deepEqual(codeMode.parseCodeModeSource("return 1;"), { code: "return 1;", options: {} });
  for (const input of ["", "// @options: {}", '\n// @options: {}\nreturn 1;',
    '// @options: {"timeout_ms":0}\nreturn 1;', '// @options: {"max_output_tokens":-1}\nreturn 1;',
    '// @options: {"unknown":1}\nreturn 1;']) assert.throws(() => codeMode.parseCodeModeSource(input));
});
