import { NextResponse } from "next/server";

type Params = Record<string, string>;
type Handler = (request: Request, context: { params: Promise<Params> }) => Promise<Response>;

export function throughCatchAll(names: readonly string[], handler: Handler) {
  return async (request: Request, context: { params: Promise<{ ids: string[] }> }) => {
    const { ids } = await context.params;
    if (ids.length !== names.length) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const params: Params = {};
    names.forEach((name, index) => {
      params[name] = ids[index];
    });
    return handler(request, { params: Promise.resolve(params) });
  };
}
