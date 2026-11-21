import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { renderPage, scoringPortal } from './pages.mjs';

const catalogue = JSON.parse(readFileSync(new URL('../sources/exchange.json', import.meta.url)));

function respond(res, status, contentType, text, headers = {}) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function json(res, status, value) {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}


export function origin() {
  let release = 0;
  const portal = scoringPortal();

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/_desk/releases' && req.method === 'GET') {
      json(res, 200, { current: catalogue.releases[release].name,
        available: catalogue.releases.map(({ name }) => name) });
      return;
    }

    if (url.pathname.startsWith('/_desk/releases/') && req.method === 'POST') {
      const name = decodeURIComponent(url.pathname.slice('/_desk/releases/'.length));
      const requested = catalogue.releases.findIndex(({ name: label }) => label === name);
      if (requested < 0) {
        json(res, 404, { error: '没有这次发布' });
        return;
      }
      release = requested;
      json(res, 200, { current: name });
      return;
    }

    const routes = catalogue.releases[release].routes;
    const route = routes[url.pathname + url.search] ?? routes[url.pathname + (url.searchParams.size ? "?" + url.searchParams.toString() : "")];
    if (!route) {
      json(res, 404, { error: '来源没有该记录或地址' });
      return;
    }

    if (req.method === 'POST' && route.layout === 'scoring') {
      const submitted = await portal.submit(req, route);
      if (submitted.error) {
        respond(res, submitted.status, 'text/html; charset=utf-8',
          renderPage(route, portal.entries(route.desk), submitted.error));
        return;
      }
      respond(res, 303, 'text/plain; charset=utf-8', '', { location: url.pathname + url.search });
      return;
    }

    if (req.method !== 'GET') {
      json(res, 405, { error: '来源不提供这个方法' });
      return;
    }

    if (route.layout) {
      respond(res, 200, 'text/html; charset=utf-8', renderPage(route, portal.entries(route.desk)));
    } else if (route.mime) {
      respond(res, route.status ?? 200, route.mime, route.text, route.headers);
    } else {
      json(res, 200, route);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  origin().listen(Number(process.env.PORT ?? 4178), '127.0.0.1', function ready() {
    console.log('资料联调站 http://127.0.0.1:' + this.address().port);
  });
}
