// Minimal API gateway that mimics the Supabase URL layout on a single port:
//   /auth/v1/*  -> Supabase Auth (GoTrue)
//   /rest/v1/*  -> PostgREST
// Local development/testing only. Hosted projects use Supabase's own gateway.
import http from "node:http";

const port = Number(process.env.PC_GATEWAY_PORT ?? 54321);
const routes = [
  { prefix: "/auth/v1", port: Number(process.env.PC_GOTRUE_PORT ?? 9999) },
  { prefix: "/rest/v1", port: Number(process.env.PC_POSTGREST_PORT ?? 54323) },
];
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer, accept-profile, content-profile, range",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD",
  "access-control-expose-headers": "content-range, content-location",
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const url = req.url ?? "/";
    const route = routes.find((r) => url === r.prefix || url.startsWith(`${r.prefix}/`) || url.startsWith(`${r.prefix}?`));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json", ...cors }).end(JSON.stringify({ message: "not found" }));
      return;
    }
    const upstreamReq = http.request(
      { host: "127.0.0.1", port: route.port, method: req.method, path: url.slice(route.prefix.length) || "/", headers: { ...req.headers, host: `127.0.0.1:${route.port}` } },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, { ...upstream.headers, ...cors });
        upstream.pipe(res);
      },
    );
    upstreamReq.on("error", () => {
      res.writeHead(502, { "content-type": "application/json", ...cors }).end(JSON.stringify({ message: "upstream unavailable" }));
    });
    req.pipe(upstreamReq);
  })
  .listen(port, "127.0.0.1", () => console.log(`gateway listening on ${port}`));
