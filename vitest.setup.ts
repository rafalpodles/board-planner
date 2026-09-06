declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof document !== "undefined" && !globalThis.localStorage) {
  const { Storage } = await import("happy-dom");
  Object.defineProperty(globalThis, "localStorage", {
    value: new Storage(),
    configurable: true,
    writable: true,
  });
}

export {};
