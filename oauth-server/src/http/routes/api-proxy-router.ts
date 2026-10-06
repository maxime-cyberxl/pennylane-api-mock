// Relais des 3 API Pennylane vers l'api-server : comme sur app.pennylane.com, /oauth/* et les API
// sont servis sous la même base URL. Le relais ne touche ni à la requête ni à la réponse :
// l'api-server vérifie lui-même le Bearer token (jeton statique, ou token OAuth par introspection).

import http from 'node:http';
import { Router } from 'express';
import type { ApiRoute } from '../../config/environment.js';
import type { Logger } from '../../logger.js';

// En-têtes propres à une connexion, à ne pas retransmettre (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const withoutHopByHop = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_BY_HOP.has(name)));

export function createApiProxyRouter(routes: ApiRoute[], logger: Logger): Router {
  const router = Router();

  for (const { prefix, target } of routes) {
    router.use(prefix, (req, res) => {
      // L'en-tête Host d'origine est conservé : l'api-server construit ses URLs (public_file_url...) avec,
      // elles pointent donc vers ce serveur et non vers l'api-server.
      const upstream = http.request(
        new URL(req.originalUrl, target),
        { method: req.method, headers: withoutHopByHop(req.headers) },
        (response) => {
          res.writeHead(response.statusCode ?? 502, withoutHopByHop(response.headers));
          response.pipe(res);
        },
      );
      upstream.on('error', (error) => {
        logger.error(`api-server unreachable (${target}): ${error.message}`);
        if (res.headersSent) res.destroy();
        else res.status(502).json({ status: 502, error: `api-server unreachable (${target})` });
      });
      req.pipe(upstream);
    });
  }

  return router;
}
