// @kubernetes/client-node ships as pure ESM ("type": "module") and pulls in
// further ESM-only deps (openid-client, rfc4648), which the CommonJS unit-test
// transform cannot load. No unit test talks to a real cluster, so the jest
// config maps the package to this stub. Every named export resolves to a no-op
// class whose instances answer any method call (returning further stubs), so
// runtime usage like `new KubeConfig().makeApiClient(CoreV1Api)` keeps working
// without dragging the ESM dependency graph into jest.
const instanceHandler: ProxyHandler<Record<string, unknown>> = {
  get: () => () => new Proxy({}, instanceHandler),
};

class KubeStub {
  constructor() {
    return new Proxy(this, instanceHandler);
  }
}

export = new Proxy(
  {},
  {
    get: (_target, prop) => {
      // Keep CommonJS interop happy: treat this as a CJS module, not ESM.
      if (prop === "__esModule") {
        return false;
      }
      return KubeStub;
    },
  },
);
