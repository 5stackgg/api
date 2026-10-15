import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";

const METADATA = join(__dirname, "../../hasura/metadata");

const yamlFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return yamlFiles(path);
    }
    return entry.endsWith(".yaml") ? [path] : [];
  });

const envReferences = (
  node: unknown,
  file: string,
): Array<{ file: string; env: string }> => {
  if (Array.isArray(node)) {
    return node.flatMap((item) => envReferences(item, file));
  }

  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) =>
      key === "value_from_env" && typeof value === "string"
        ? [{ file, env: value }]
        : envReferences(value, file),
    );
  }

  return [];
};

describe("hasura metadata env references", () => {
  const files = yamlFiles(METADATA);

  it("reads the metadata tree", () => {
    expect(files.some((file) => file.endsWith("actions.yaml"))).toBe(true);
  });

  // Hasura refuses the whole metadata apply (parse-failed) when a header reads
  // a HASURA_GRAPHQL_* variable, and the pod then never starts.
  it("never reads a HASURA_GRAPHQL_* variable through value_from_env", () => {
    const reserved = files
      .flatMap((file) =>
        envReferences(yaml.load(readFileSync(file, "utf8")), file),
      )
      .filter(({ env }) => env.startsWith("HASURA_GRAPHQL_"))
      .map(({ file, env }) => `${file.slice(METADATA.length + 1)}: ${env}`);

    expect(reserved).toEqual([]);
  });
});
