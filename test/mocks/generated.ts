// generated/ is the genql client: ~14MB of compiled JS plus a linkTypeMap pass
// over all of it at import time, about a second per suite. Jest re-evaluates
// every module for each test file, and most suites only reach it through
// HasuraService's import of createClient without ever building a client. The
// jest config maps the import here, and the real module loads on first use
// instead of on import. The absolute path does not match that mapping.
import { join } from "path";

let generated: object | undefined;

export = new Proxy(
  {},
  {
    get: (_target, prop) => {
      generated ??= require(join(__dirname, "..", "..", "generated"));
      return Reflect.get(generated!, prop);
    },
  },
);
