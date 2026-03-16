import { describe, expect, test } from "bun:test";
import { parseEnvFile, findMissingVars } from "../src/utils/env";

describe("env utilities", () => {
  test("parseEnvFile parses KEY=value lines", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("parseEnvFile ignores comments and blank lines", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n\n# another\n");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("parseEnvFile handles quoted values", () => {
    const result = parseEnvFile('FOO="bar baz"\nQUX=\'hello\'');
    expect(result).toEqual({ FOO: "bar baz", QUX: "hello" });
  });

  test("findMissingVars detects placeholder values", () => {
    const example = { FOO: "...", BAR: "real-value", BAZ: "fo1_..." };
    const actual = { FOO: "...", BAR: "real-value", BAZ: "fo1_..." };
    const missing = findMissingVars(example, actual);
    expect(missing).toContain("FOO");
    expect(missing).toContain("BAZ");
    expect(missing).not.toContain("BAR");
  });
});
