import "reflect-metadata";

// sharp ships a native binary that is not installable on every dev machine, and
// importing AppModule pulls it in transitively. Nothing here calls it -- only
// the module metadata is read -- so a stub is enough, and without it this guard
// only runs on the platforms sharp happens to support.
jest.mock("sharp", () => ({ __esModule: true, default: () => ({}) }), {
  virtual: true,
});

import { AppModule } from "./app.module";

// A module that imports another which (transitively) imports it back resolves to
// `undefined` at metadata-read time, and Nest refuses to boot with
// "the module at index [n] is undefined". Nothing else catches it: tsc is happy,
// every unit and SQL suite passes, and the failure only appears when the API
// starts.
//
// app.e2e-spec.ts was meant to cover this but has no it() block, so jest skips
// the file entirely. This walks the same graph without needing Redis, Postgres
// or any of the connections a real boot opens.
describe("module graph", () => {
  type ModuleClass = { name?: string };

  const walk = (
    root: ModuleClass,
  ): Array<{ module: string; index: number }> => {
    const problems: Array<{ module: string; index: number }> = [];
    const seen = new Set<unknown>();
    const queue: Array<ModuleClass> = [root];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (!current || seen.has(current)) {
        continue;
      }

      seen.add(current);

      const imports: Array<unknown> =
        Reflect.getMetadata("imports", current as object) ?? [];

      imports.forEach((imported, index) => {
        if (imported === undefined || imported === null) {
          problems.push({ module: current.name ?? "unknown", index });
          return;
        }

        // A dynamic module registration ({ module, providers, ... }) rather than
        // a class; follow the class it names.
        const target =
          typeof imported === "object" && "module" in (imported as object)
            ? (imported as { module: ModuleClass }).module
            : (imported as ModuleClass);

        if (typeof target === "function") {
          queue.push(target);
        }
      });
    }

    return problems;
  };

  it("has no undefined imports anywhere under AppModule", () => {
    const problems = walk(AppModule as ModuleClass);

    expect(
      problems.map(
        ({ module, index }) =>
          `${module} imports[${index}] is undefined (circular import?)`,
      ),
    ).toEqual([]);
  });
});
