export default {
  fetch(request: Request, _env: Env, _ctx: ExecutionContext): Response {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
