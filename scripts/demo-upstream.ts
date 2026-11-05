/**
 * A throwaway upstream for trying the gateway by hand. It echoes the request it received
 * and can be told to misbehave: `?status=503` picks the status, `?delay=2000` delays the reply.
 */
import { createServer } from 'node:http';

const port = Number(process.env.UPSTREAM_PORT ?? 4001);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const status = Number(url.searchParams.get('status') ?? 200);
  const delayMs = Number(url.searchParams.get('delay') ?? 0);
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.stringify(
      {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      },
      null,
      2,
    );
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    }, delayMs);
  });
});

server.listen(port, () => {
  process.stdout.write(`demo upstream listening on http://localhost:${port}\n`);
});
