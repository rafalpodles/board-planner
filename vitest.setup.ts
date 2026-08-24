// React needs this flag to accept act(...) from a test runner
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Node 26 defines localStorage on globalThis and reads it as undefined without
// --localstorage-file; vitest's happy-dom environment leaves globals it did not create alone, so
// the DOM's own Storage never lands. sessionStorage needs no such repair — Node's is in-memory
if (typeof document !== "undefined" && !globalThis.localStorage) {
  const { Storage } = await import("happy-dom");
  Object.defineProperty(globalThis, "localStorage", {
    value: new Storage(),
    configurable: true,
    writable: true,
  });
}

export {};
