/**
 * RebornRank Cloudflare Pages advanced-mode worker.
 * Keeps external anime/manga APIs server-side so the browser only calls rebornrank.pages.dev.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/anilist') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      try {
        const body = await request.text();
        const upstream = await fetch('https://graphql.anilist.co', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'RebornRank/1.0 (+https://rebornrank.pages.dev)'
          },
          body
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            'Cache-Control': upstream.ok ? 'public, max-age=120, s-maxage=600' : 'no-store',
            'X-RebornRank-Source': 'AniList'
          }
        });
      } catch (err) {
        return Response.json({ error: 'AniList proxy unavailable', detail: String(err?.message || err) }, { status: 502 });
      }
    }

    if (url.pathname === '/api/jikan') {
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      const kind = url.searchParams.get('kind');
      if (kind !== 'anime' && kind !== 'manga') return Response.json({ error: 'Invalid kind' }, { status: 400 });

      const allowed = new Set(['sfw','page','limit','genres','order_by','sort','type','status','q','min_score','max_score','start_date','end_date']);
      const params = new URLSearchParams();
      for (const [k, v] of url.searchParams) {
        if (k !== 'kind' && allowed.has(k)) params.append(k, v);
      }
      const upstreamUrl = `https://api.jikan.moe/v4/${kind}?${params.toString()}`;
      try {
        const upstream = await fetch(upstreamUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'RebornRank/1.0 (+https://rebornrank.pages.dev)'
          }
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: {
            'Content-Type': upstream.headers.get('Content-Type') || 'application/json; charset=utf-8',
            'Cache-Control': upstream.ok ? 'public, max-age=300, s-maxage=3600' : 'no-store',
            'X-RebornRank-Source': 'Jikan'
          }
        });
      } catch (err) {
        return Response.json({ error: 'Jikan proxy unavailable', detail: String(err?.message || err) }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
