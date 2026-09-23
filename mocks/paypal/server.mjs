#!/usr/bin/env node
// PLACEHOLDER del mock de paypal — lo implementa otra pieza (ver SPEC.md "Stack").
// Contrato: mismo formato de endpoints/respuestas/errores que la API real.
// Por ahora solo responde GET /health y 501 para lo demás.
import http from 'node:http';

const port = Number(process.env.MOCK_PAYPAL_PORT ?? 4020);
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mock: 'paypal' })); }
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'mock paypal no implementado todavía' }));
});
server.listen(port, () => console.log('mock paypal escuchando en http://localhost:' + port));
