const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { buscarGrabacionesMusicBrainz } = require('./utils/musicBrainzService');
const JamendoSource = require('./sources/JamendoSource');
const InternetArchiveSource = require('./sources/InternetArchiveSource');
const LegacyScraperSource = require('./sources/LegacyScraperSource');

const jamendoSource = new JamendoSource();
const internetArchiveSource = new InternetArchiveSource();
const legacyScraperSource = new LegacyScraperSource();
const ENABLE_LEGACY_SCRAPERS = process.env.ENABLE_LEGACY_SCRAPERS !== 'false';

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_PUBLIC = path.join(__dirname, 'public');
const RUTA_DIST_LOCAL = path.join(__dirname, 'dist');
const RUTA_DIST_FRONTEND = path.join(__dirname, '..', 'app-musica', 'dist');

// Orden de resolución para la carpeta de archivos estáticos (OTA / PWA):
// 1. public/ en servidor-musica (para Render con frontend empaquetado)
// 2. dist/ en servidor-musica
// 3. ../app-musica/dist (para monorepo local en desarrollo)
const RUTA_ESTATICOS = (fs.existsSync(path.join(RUTA_PUBLIC, 'index.html')))
  ? RUTA_PUBLIC
  : (fs.existsSync(path.join(RUTA_DIST_LOCAL, 'index.html')))
    ? RUTA_DIST_LOCAL
    : (fs.existsSync(path.join(RUTA_DIST_FRONTEND, 'index.html')))
      ? RUTA_DIST_FRONTEND
      : RUTA_PUBLIC;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Middleware y CORS abierto
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Titulo-Audio']
}));

app.use(express.json());

// Compresión HTTP ligera (Brotli / Gzip) con zlib nativo para respuestas JSON, JS, CSS, HTML y SVG
app.use((req, res, next) => {
  const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();
  const supportsBr = acceptEncoding.includes('br');
  const supportsGzip = acceptEncoding.includes('gzip');
  if ((!supportsBr && !supportsGzip) || req.path.startsWith('/api/proxy-stream')) {
    return next();
  }

  const origSend = res.send.bind(res);
  res.send = (body) => {
    try {
      if (res.headersSent || !body) return origSend(body);
      const ct = String(res.getHeader('Content-Type') || '').toLowerCase();
      const esComprimible =
        typeof body === 'string' ||
        ct.includes('json') ||
        ct.includes('javascript') ||
        ct.includes('css') ||
        ct.includes('html') ||
        ct.includes('svg');
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      if (!esComprimible || buf.length < 1024) {
        return origSend(body);
      }
      res.setHeader('Vary', 'Accept-Encoding');
      if (supportsBr) {
        res.setHeader('Content-Encoding', 'br');
        res.removeHeader('Content-Length');
        return origSend(zlib.brotliCompressSync(buf));
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.removeHeader('Content-Length');
      return origSend(zlib.gzipSync(buf));
    } catch (_) {
      return origSend(body);
    }
  };
  next();
});

// Endpoint de chequeo de salud para Render y detección OTA automática
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    server: 'servidor-musica',
    version: 'v5.3.0',
    cacheVersion: 'app-musica-v5.3.0',
    port: PUERTO,
    mode: 'client-direct-download + direct-link-resolver'
  });
});

// ---------------------------------------------------------------------------
// ENDPOINT: POST /api/spotify/playlist
// Extrae metadatos (título, artista, carátula, duración) de una playlist pública
// de Spotify desde https://open.spotify.com/embed/playlist/${playlistId} sin API Keys
// ---------------------------------------------------------------------------
function extraerRecursoSpotify(inputUrl = '') {
  const limpio = String(inputUrl || '').trim();
  if (!limpio) return null;
  const matchUri = limpio.match(/spotify:(playlist|album|track):([a-zA-Z0-9]{15,35})/i);
  if (matchUri && matchUri[1] && matchUri[2]) {
    return { tipo: matchUri[1].toLowerCase(), id: matchUri[2] };
  }
  const matchUrl = limpio.match(/(playlist|album|track)\/([a-zA-Z0-9]{15,35})/i);
  if (matchUrl && matchUrl[1] && matchUrl[2]) {
    return { tipo: matchUrl[1].toLowerCase(), id: matchUrl[2] };
  }
  if (/^[a-zA-Z0-9]{22}$/.test(limpio)) {
    return { tipo: 'playlist', id: limpio };
  }
  return null;
}

function decodificarHtmlEntities(str = '') {
  return String(str || '')
    .replace(/\u00a0/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

app.post('/api/spotify/playlist', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  let rawUrl = (req.body && req.body.url) ? String(req.body.url).trim() : '';

  // Resolver enlaces acortados (spotify.link / spoti.fi)
  if (/^https?:\/\/(spotify\.link|spoti\.fi)\//i.test(rawUrl)) {
    try {
      const redirRes = await axios.get(rawUrl, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { 'User-Agent': UA },
        validateStatus: () => true
      });
      const finalUrl = redirRes?.request?.res?.responseUrl || redirRes?.headers?.location || '';
      if (finalUrl) rawUrl = finalUrl;
    } catch (eRedir) {
      console.warn('[/api/spotify/playlist]: No se pudo resolver enlace corto:', eRedir.message);
    }
  }

  const recurso = extraerRecursoSpotify(rawUrl);

  if (!recurso) {
    return res.status(400).json({
      error: true,
      mensaje: 'Enlace de Spotify inválido. Pega un enlace de playlist, álbum o canción (open.spotify.com/...).'
    });
  }

  const { tipo, id: playlistId } = recurso;
  const embedUrl = `https://open.spotify.com/embed/${tipo}/${playlistId}`;
  const publicUrl = `https://open.spotify.com/${tipo}/${playlistId}`;

  console.log(`\n[/api/spotify/playlist]: Analizando ${tipo} ID: ${playlistId}`);

  try {
    let nombrePlaylist = 'Playlist de Spotify';
    let caratulaPlaylist = '';
    const cancionesExtraidas = [];
    const vistos = new Set();

    const agregarCancionUnica = (title, artist, thumbnail, durationMs = 0, trackId = '') => {
      const tLimpio = decodificarHtmlEntities(title);
      const aLimpio = decodificarHtmlEntities(artist);
      if (!tLimpio) return;
      const clave = `${tLimpio.toLowerCase()}:::${aLimpio.toLowerCase()}`;
      if (vistos.has(clave)) return;
      vistos.add(clave);
      const seconds = durationMs > 0 ? Math.round(durationMs / 1000) : 0;
      const mins = Math.floor(seconds / 60);
      const rem = seconds % 60;
      cancionesExtraidas.push({
        id: trackId || `sp_${playlistId}_${cancionesExtraidas.length + 1}`,
        title: tLimpio,
        artist: aLimpio || 'Spotify Artist',
        thumbnail: thumbnail || caratulaPlaylist || '',
        seconds,
        timestamp: seconds > 0 ? `${mins}:${rem < 10 ? '0' : ''}${rem}` : '3:30'
      });
    };

    // 1. Consultar la vista embed oficial de Spotify (sin API Keys)
    let htmlEmbed = '';
    try {
      const respEmbed = await axios.get(embedUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        signal: AbortSignal.timeout(12000),
        timeout: 12000
      });
      htmlEmbed = typeof respEmbed.data === 'string' ? respEmbed.data : '';
    } catch (eEmbed) {
      console.warn('[/api/spotify/playlist]: Aviso al consultar embed:', eEmbed.message);
    }

    // 1.A. Parsear __NEXT_DATA__ en la vista embed
    if (htmlEmbed) {
      const matchNextData = htmlEmbed.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (matchNextData && matchNextData[1]) {
        try {
          const nextJson = JSON.parse(matchNextData[1]);
          const entity =
            nextJson?.props?.pageProps?.state?.data?.entity ||
            nextJson?.props?.pageProps?.entity ||
            nextJson?.props?.pageProps?.state?.data?.playlist ||
            null;

          if (entity) {
            if (entity.name || entity.title) {
              nombrePlaylist = decodificarHtmlEntities(entity.name || entity.title);
            }
            const coverImg =
              entity.coverArt?.sources?.[0]?.url ||
              entity.images?.[0]?.url ||
              entity.visualIdentity?.image?.[0]?.url ||
              '';
            if (coverImg) caratulaPlaylist = coverImg;

            const trackList =
              entity.trackList ||
              entity.tracks?.items ||
              [];

            if (Array.isArray(trackList)) {
              for (const item of trackList) {
                const trackObj = item?.track || item?.itemV2?.data || item;
                if (!trackObj) continue;
                const tTitle = trackObj.title || trackObj.name || '';
                const tArtist =
                  trackObj.subtitle ||
                  (Array.isArray(trackObj.artists)
                    ? trackObj.artists.map((a) => a.name || a.title || '').filter(Boolean).join(', ')
                    : '') ||
                  (Array.isArray(trackObj.artists?.items)
                    ? trackObj.artists.items.map((a) => a.profile?.name || a.name || '').filter(Boolean).join(', ')
                    : '');
                const tThumb =
                  trackObj.album?.images?.[0]?.url ||
                  trackObj.albumOfTrack?.coverArt?.sources?.[0]?.url ||
                  trackObj.coverArt?.sources?.[0]?.url ||
                  trackObj.imageUrl ||
                  caratulaPlaylist ||
                  '';
                const tDur = trackObj.duration || trackObj.duration_ms || trackObj.trackDuration?.totalMilliseconds || 0;
                const tUri = trackObj.uri || trackObj.id || '';
                agregarCancionUnica(tTitle, tArtist, tThumb, tDur, tUri);
              }
            }

            // Si es un enlace directo de canción (/track/...), entity es la propia canción
            if (cancionesExtraidas.length === 0 && (tipo === 'track' || entity.type === 'track')) {
              const tTitle = entity.title || entity.name || '';
              const tArtist =
                entity.subtitle ||
                (Array.isArray(entity.artists)
                  ? entity.artists.map((a) => a.name || a.title || '').filter(Boolean).join(', ')
                  : '') ||
                '';
              const tDur = entity.duration || entity.duration_ms || 0;
              const tUri = entity.uri || entity.id || playlistId;
              agregarCancionUnica(tTitle, tArtist, caratulaPlaylist, tDur, tUri);
            }
          }
        } catch (errJson) {
          console.warn('[/api/spotify/playlist]: Error parseando __NEXT_DATA__:', errJson.message);
        }
      }

      // 1.B. Fallback: Parsear initial-state base64 si existe
      if (cancionesExtraidas.length === 0) {
        const matchInitState = htmlEmbed.match(/<script id="initial-state"[^>]*>([\s\S]*?)<\/script>/i);
        if (matchInitState && matchInitState[1]) {
          try {
            const decoded = Buffer.from(matchInitState[1].trim(), 'base64').toString('utf8');
            const stateJson = JSON.parse(decoded);
            const entities = stateJson?.entities?.items || {};
            for (const key of Object.keys(entities)) {
              const plObj = entities[key];
              if (plObj?.name) nombrePlaylist = plObj.name;
              const items = plObj?.content?.items || plObj?.tracks?.items || [];
              for (const it of items) {
                const tr = it?.itemV2?.data || it?.track || it;
                if (!tr) continue;
                const tTitle = tr.name || tr.title || '';
                const tArtist = (tr.artists?.items || tr.artists || [])
                  .map((a) => a?.profile?.name || a?.name || '')
                  .filter(Boolean)
                  .join(', ');
                const tThumb =
                  tr.albumOfTrack?.coverArt?.sources?.[0]?.url ||
                  tr.album?.images?.[0]?.url ||
                  caratulaPlaylist ||
                  '';
                const tDur = tr.trackDuration?.totalMilliseconds || tr.duration_ms || 0;
                agregarCancionUnica(tTitle, tArtist, tThumb, tDur, tr.uri || tr.id || '');
              }
            }
          } catch (_) {}
        }
      }

      // 1.C. Fallback Regex directo sobre JSON embebido en el HTML del embed
      if (cancionesExtraidas.length === 0) {
        const regexTrackList = /"title"\s*:\s*"((?:[^"\\]|\\.)+)"\s*,\s*"subtitle"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
        let m;
        while ((m = regexTrackList.exec(htmlEmbed)) !== null) {
          try {
            const t = JSON.parse(`"${m[1]}"`);
            const a = JSON.parse(`"${m[2]}"`);
            if (t && a && t.toLowerCase() !== nombrePlaylist.toLowerCase()) {
              agregarCancionUnica(t, a, caratulaPlaylist, 0);
            }
          } catch (_) {}
        }
      }
    }

    // 2. Si el embed no trajo todas o falló, intentar con la vista pública de open.spotify.com/playlist/${playlistId}
    if (cancionesExtraidas.length === 0) {
      try {
        const respPublic = await axios.get(publicUrl, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          signal: AbortSignal.timeout(10000),
          timeout: 10000
        });
        const htmlPub = typeof respPublic.data === 'string' ? respPublic.data : '';
        if (htmlPub) {
          const ogTitle = htmlPub.match(/<meta property="og:title" content="([^"]+)"/i);
          if (ogTitle && ogTitle[1]) nombrePlaylist = decodificarHtmlEntities(ogTitle[1]);
          const ogImg = htmlPub.match(/<meta property="og:image" content="([^"]+)"/i);
          if (ogImg && ogImg[1]) caratulaPlaylist = ogImg[1];

          const trackMetaRegex = /"name"\s*:\s*"((?:[^"\\]|\\.)+)"[^}]{0,300}"artists"\s*:\s*\[\s*\{\s*"name"\s*:\s*"((?:[^"\\]|\\.)+)"/g;
          let mPub;
          while ((mPub = trackMetaRegex.exec(htmlPub)) !== null) {
            try {
              const t = JSON.parse(`"${mPub[1]}"`);
              const a = JSON.parse(`"${mPub[2]}"`);
              agregarCancionUnica(t, a, caratulaPlaylist, 0);
            } catch (_) {}
          }
        }
      } catch (ePub) {
        console.warn('[/api/spotify/playlist]: Aviso en vista pública:', ePub.message);
      }
    }

    if (cancionesExtraidas.length === 0) {
      return res.status(404).json({
        error: true,
        mensaje: 'No se pudieron encontrar canciones en esa playlist. Verifica que la playlist de Spotify sea pública.'
      });
    }

    console.log(`[/api/spotify/playlist Éxito]: "${nombrePlaylist}" -> ${cancionesExtraidas.length} canciones extraídas`);

    return res.json({
      ok: true,
      playlistId,
      nombre: nombrePlaylist,
      caratula: caratulaPlaylist || (cancionesExtraidas[0] && cancionesExtraidas[0].thumbnail) || '',
      total: cancionesExtraidas.length,
      canciones: cancionesExtraidas
    });
  } catch (error) {
    console.error('[Error /api/spotify/playlist]:', error.message || error);
    return res.status(500).json({
      error: true,
      mensaje: 'Error al analizar la playlist de Spotify. Intenta nuevamente.'
    });
  }
});

// ---------------------------------------------------------------------------
// Extractores para resolver downloadUrl directa (MP3 / M4A)
// ---------------------------------------------------------------------------

// 1. Cobalt con AbortSignal.timeout(10000)
async function resolverCobalt(videoUrl) {
  const cobaltInstances = [
    'https://cobalt-api.kwiatekm.tokyo/',
    'https://api.cobalt.0011001100.xyz/',
    'https://cobalt.tools.api.alextesting.ninja/',
    'https://api.savefrom.net/'
  ];

  for (const cobaltUrl of cobaltInstances) {
    try {
      const cRes = await axios.post(cobaltUrl, {
        url: videoUrl,
        downloadMode: 'audio',
        audioFormat: 'mp3'
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': UA
        },
        signal: AbortSignal.timeout(10000),
        timeout: 10000,
        validateStatus: () => true
      });

      if (cRes.data && (cRes.data.status === 'tunnel' || cRes.data.status === 'redirect') && cRes.data.url) {
        console.log(`[Cobalt Éxito]: Resuelto enlace desde ${cobaltUrl}`);
        return cRes.data.url;
      }
    } catch (_) {
      // Aborta y salta inmediatamente al siguiente si no responde en 10s
    }
  }
  return null;
}

// Normalizador inteligente de formatos soportados por el motor de descarga
function normalizarFormato(formato) {
  if (!formato) return 'mp3';
  const f = formato.toLowerCase().trim();
  if (f === 'm4a') return 'm4a';
  if (f.includes('720') || f.includes('hd')) return '720';
  if (f.includes('1080')) return '1080';
  if (f.includes('360') || f.includes('240') || f.includes('144')) return '360';
  return 'mp3';
}

// 1. Extractor Directo Ultra Rápido (Savenow / Loader) con AbortSignal.timeout(10000)
async function resolverExtractorDirecto(videoUrl, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const dominios = [
    'https://p.savenow.to',
    'https://loader.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominios) {
    try {
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: formato, url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
        signal: AbortSignal.timeout(10000),
        timeout: 10000
      });

      if (!startRes.data || !startRes.data.id) continue;

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      // Polling inteligente cada 900ms respetando AbortSignal.timeout(10000)
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 900));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://loader.to/' },
            signal: AbortSignal.timeout(10000),
            timeout: 10000
          });

          const pData = pRes.data;
          if (!pData) continue;

          const downloadLink = pData.download_url || (pData.progress >= 1000 ? pData.url : null);
          if (
            downloadLink &&
            typeof downloadLink === 'string' &&
            downloadLink.length > 15 &&
            !downloadLink.includes('b.php') &&
            !downloadLink.includes('ey43.com') &&
            (pData.success === 1 || pData.success === true || pData.progress >= 1000 || pData.text === 'Finished')
          ) {
            const httpsLink = downloadLink.replace(/^http:\/\//i, 'https://');
            console.log(`[Extractor Directo Éxito (${formato})]: Resuelto en intento ${i + 1} desde ${dominio} -> ${httpsLink.substring(0, 75)}...`);
            return httpsLink;
          }

          if (pData.text && pData.text.toLowerCase().includes('error')) {
            console.warn(`[Extractor Directo]: Error en progreso (${dominio}): ${pData.text}`);
            break;
          }
        } catch (_) {}
      }
    } catch (errDom) {
      console.warn(`[Aviso extractor ${dominio}]:`, errDom.message || errDom);
    }
  }
  return null;
}

// 2. Invidious Mirrors con AbortSignal.timeout(10000) (Fallback secundario estándar 160k/128k)
async function resolverInvidiousPiped(videoId) {
  const invidiousHosts = [
    'https://invidious.jing.rocks',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.f5.si',
    'https://inv.tux.pizza'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(10000),
        timeout: 10000,
        headers: { 'User-Agent': UA }
      });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos.find((f) => String(f.itag) === '251') || formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Invidious Éxito]: Resuelto formato adaptativo desde ${host}`);
        return mejor.url;
      }
    } catch (_) {
      // Aborta en 10s y salta inmediatamente al siguiente
    }
  }
  return null;
}

// SoundCloud ELIMINADO por completo del flujo (v4.2.0): saturado de covers subidos por usuarios.

const {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato: normalizarFormatoCascada,
  buscarVideoOriginalEnYouTube,
  buscarCandidatosOficiales,
  construirConsultasOriginalYRescate
} = require('./utils/cascadeResolver');

// Función maestra para resolver el enlace de descarga directa con soporte de formatos (Cascada de 3 niveles)
async function resolverDirectAudioUrl(video, busqueda, formatoDeseado = 'mp3') {
  const res = await resolverAudioConCascada(video, busqueda, formatoDeseado);
  return res ? res.url : null;
}

// Cache de búsquedas en memoria (15 minutos de persistencia) para velocidad instantánea
const cacheBusquedaCanciones = new Map();

// Helper universal para localizar pista oficial DDEX en YouTube Music (categoría SONG)
async function buscarVideoEnYouTube(busqueda, artista = '', duracionRefSegs = 0, isrc = '') {
  const videoOriginal = await buscarVideoOriginalEnYouTube(busqueda, artista, duracionRefSegs, isrc);
  if (videoOriginal) return videoOriginal;
  return null;
}

// ---------------------------------------------------------------------------
// ENDPOINT: /api/buscar-canciones
// Devuelve lista de canciones coincidentes de forma ultra rápida
// ---------------------------------------------------------------------------
app.get('/api/buscar-canciones', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const busqueda = (req.query.q || '').trim();
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el texto de búsqueda en ?q=' });
  }

  const claveCache = busqueda.toLowerCase();
  const cached = cacheBusquedaCanciones.get(claveCache);
  if (cached && (Date.now() - cached.timestamp < 15 * 60 * 1000)) {
    console.log(`[Cache Hit /api/buscar-canciones]: "${busqueda}" (${cached.resultados.length} canciones)`);
    return res.json({
      consulta: busqueda,
      total: cached.resultados.length,
      resultados: cached.resultados
    });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/buscar-canciones: "${busqueda}"`);

  const fuentesActivas = [jamendoSource, internetArchiveSource, legacyScraperSource].filter((f) =>
    f.isEnabled()
  );

  const lotesResultados = await Promise.all(
    fuentesActivas.map((fuente) => fuente.search(busqueda, 15).catch(() => []))
  );

  const resultadosCombinados = lotesResultados.flat();

  const resultados = resultadosCombinados.slice(0, 30).map((v) => ({
    videoId: v.videoId || v.id,
    title: v.title,
    artist: v.artist || v.author || '',
    author: v.author || v.artist || '',
    license: v.license || 'Creative Commons',
    timestamp: v.timestamp || `${Math.floor((v.seconds || 0) / 60)}:${(v.seconds || 0) % 60 < 10 ? '0' : ''}${(v.seconds || 0) % 60}`,
    seconds: v.seconds || 0,
    thumbnail: v.thumbnail || v.image || '',
    previewUrl: v.previewUrl || v.streamUrl || '',
    streamUrl: v.streamUrl || '',
    sourceVersion: v.sourceVersion || 'cc_source'
  }));

  // Guardar en cache para respuestas inmediatas posteriores
  if (cacheBusquedaCanciones.size > 200) {
    const primeraClave = cacheBusquedaCanciones.keys().next().value;
    cacheBusquedaCanciones.delete(primeraClave);
  }
  cacheBusquedaCanciones.set(claveCache, { timestamp: Date.now(), resultados });

  console.log(`[Resultados devueltos]: ${resultados.length} canciones para "${busqueda}"`);

  return res.json({
    consulta: busqueda,
    total: resultados.length,
    resultados
  });
});

// ---------------------------------------------------------------------------
// ENDPOINT 1: /api/obtener-enlace
// Devuelve JSON con titulo, artista, duracion y downloadUrl para descarga por cliente
// ---------------------------------------------------------------------------
const { streamCacheMiddleware } = require('./middlewares/streamCache');
app.use('/api/obtener-enlace', streamCacheMiddleware);

app.get('/api/obtener-enlace', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  let respondido = false;
  const timeoutGuard = setTimeout(() => {
    if (!respondido && !res.headersSent) {
      respondido = true;
      return res.status(504).json({
        error: true,
        mensaje: 'Audio no disponible temporalmente (Tiempo de espera agotado >60s)'
      });
    }
  }, 65000);

  const finalizar = (status, payload) => {
    clearTimeout(timeoutGuard);
    if (!respondido && !res.headersSent) {
      respondido = true;
      return res.status(status).json(payload);
    }
  };

  const videoIdParam = String(req.query.videoId || '').trim();
  if (videoIdParam.startsWith('jamendo:') || videoIdParam.startsWith('ia:')) {
    try {
      const fuente = videoIdParam.startsWith('jamendo:') ? jamendoSource : internetArchiveSource;
      const streamInfo = await fuente.getStream(videoIdParam);
      if (!streamInfo || !streamInfo.downloadUrl) {
        return finalizar(404, { error: true, mensaje: 'No se encontró enlace de audio con licencia para esta pista.' });
      }
      return finalizar(200, {
        title: String(req.query.q || ''),
        artist: streamInfo.author || String(req.query.artist || ''),
        license: streamInfo.license,
        downloadUrl: streamInfo.downloadUrl
      });
    } catch (errCc) {
      return finalizar(502, { error: true, mensaje: errCc?.message || 'Error resolviendo fuente con licencia' });
    }
  }

  if (!ENABLE_LEGACY_SCRAPERS) {
    return finalizar(403, {
      error: true,
      mensaje: 'Las fuentes legacy de scraping están desactivadas por configuración (ENABLE_LEGACY_SCRAPERS=false).'
    });
  }

  req.on('close', () => {
    clearTimeout(timeoutGuard);
  });

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();
  const formatoDeseado = (req.query.formato || req.query.calidad || req.query.format || 'mp3').toLowerCase().trim();
  // Modo estricto (importaciones de Spotify y botón 🔄): ignora el videoId del cliente y exige máster oficial verificado
  const modoEstricto = req.query.estricto === '1' || req.query.estricto === 'true' || req.query.forzarOficial === '1' || req.query.forzarOficial === 'true' || req.query.origen === 'spotify';

  if (!busqueda && !videoId) {
    return finalizar(400, { error: true, mensaje: 'Debes enviar ?q= o ?videoId=' });
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/obtener-enlace: "${busqueda}" (videoId: ${videoId || 'auto'})`);

  try {
    let video = null;

    if (!modoEstricto && videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido },
        esStubCliente: true
      };
    } else {
      video = await buscarVideoEnYouTube(busqueda, artistaSugerido, duracionSugerida);
      if (video) {
        video.duracionRef = duracionSugerida || video.seconds || 0;
        video.tituloOriginal = busqueda;
        video.artistaOriginal = artistaSugerido;
      }
    }

    if (!video) {
      video = {
        videoId: '',
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido },
        esVerificadoOficial: false
      };
    }

    const trackTitle = video.title || busqueda;
    const trackArtist = (video.author && video.author.name) ? video.author.name : artistaSugerido;
    const trackDuration = video.seconds || duracionSugerida || 0;

    console.log(`[Video Seleccionado]: "${trackTitle}" (${trackDuration}s, ID: ${video.videoId || 'N/A'})`);

    // 2. Resolver enlace con la cascada oficial de estudio (YouTube + SoundCloud + Audius + IA)
    const resultadoAudio = await resolverAudioConCascada(video, busqueda, formatoDeseado, { estricto: modoEstricto });

    if (!resultadoAudio || !resultadoAudio.url) {
      console.warn(`[Aviso Cascada Oficial]: Audio oficial no disponible para "${busqueda}".`);
      return finalizar(404, {
        error: true,
        mensaje: 'Audio oficial de estudio no disponible'
      });
    }

    let downloadUrlFinal = resultadoAudio.url;
    if (
      resultadoAudio.esHlsSoundCloud ||
      (resultadoAudio.proveedor === 'ytdl-native-stream' && downloadUrlFinal.includes('googlevideo.com'))
    ) {
      downloadUrlFinal = `/api/proxy-stream?url=${encodeURIComponent(downloadUrlFinal)}&q=${encodeURIComponent(busqueda)}&artist=${encodeURIComponent(artistaSugerido)}&seconds=${trackDuration}${modoEstricto ? '&estricto=1' : ''}`;
    }

    console.log(`[Éxito Cascada]: Enlace entregado al cliente (${resultadoAudio.calidad} / ${resultadoAudio.proveedor}): ${downloadUrlFinal.substring(0, 80)}...`);

    return finalizar(200, {
      titulo: trackTitle,
      artista: trackArtist,
      duracion: trackDuration,
      downloadUrl: downloadUrlFinal,
      calidad: resultadoAudio.calidad,
      proveedor: resultadoAudio.proveedor
    });

  } catch (error) {
    console.error(`[Error /api/obtener-enlace]:`, error.message || error);
    return finalizar(500, {
      error: true,
      mensaje: 'Audio no disponible temporalmente'
    });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: POST /api/buscar-candidatos-oficiales
// Devuelve hasta 4 candidatos reales (YouTube Music + YouTube - Topic) para vista previa
// ---------------------------------------------------------------------------
app.options('/api/buscar-candidatos-oficiales', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.sendStatus(204);
});

app.post('/api/buscar-candidatos-oficiales', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const limpiar = (txt) =>
    String(txt || '').replace(/_\d{6,}/g, ' ').replace(/\b\d{10,}\b/g, ' ').replace(/\s+/g, ' ').trim();

  const titulo = limpiar(req.body?.titulo || '');
  const artista = limpiar(req.body?.artista || '');
  const duracionSegundos = parseInt(req.body?.duracionSegundos) || 0;

  if (!titulo) {
    return res.status(400).json({ error: true, mensaje: 'Debes enviar titulo' });
  }

  try {
    const candidatos = await buscarCandidatosOficiales(titulo, artista, duracionSegundos);
    return res.json({
      ok: true,
      total: candidatos.length,
      candidatos
    });
  } catch (err) {
    console.error('[Error /api/buscar-candidatos-oficiales]:', err.message || err);
    return res.status(500).json({ error: true, mensaje: 'Error al buscar candidatos oficiales' });
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: POST /api/resolver-oficial
// Reemplazo Hi-Fi exclusivo para el botón 🔄 y descargas oficiales forzadas
// ---------------------------------------------------------------------------
app.options('/api/resolver-oficial', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.sendStatus(204);
});

app.post('/api/resolver-oficial', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Titulo-Audio, X-Calidad-Audio');

  const limpiar = (txt) =>
    String(txt || '').replace(/_\d{6,}/g, ' ').replace(/\b\d{10,}\b/g, ' ').replace(/\s+/g, ' ').trim();

  const titulo = limpiar(req.body?.titulo || '');
  const artista = limpiar(req.body?.artista || '');
  const isrc = String(req.body?.isrc || '').trim();
  const videoIdSolicitado = String(req.body?.videoId || '').trim();
  const duracionSegundos = parseInt(req.body?.duracionSegundos) || 0;

  if (!titulo && !videoIdSolicitado) {
    return res.status(400).json({ error: true, mensaje: 'Debes enviar titulo o videoId' });
  }

  let respondido = false;
  let streamActivo = null;
  const timeoutGuard = setTimeout(() => {
    if (!respondido && !res.headersSent) {
      respondido = true;
      if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
      return res.status(504).json({ error: true, mensaje: 'Tiempo de espera agotado al resolver audio oficial' });
    }
  }, 60000);

  res.on('close', () => {
    clearTimeout(timeoutGuard);
    if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
  });

  try {
    console.log(`\n[POST /api/resolver-oficial]: "${artista ? `${artista} - ` : ''}${titulo}" (videoId: ${videoIdSolicitado || 'auto'}, durRef: ${duracionSegundos}s${isrc ? `, ISRC: ${isrc}` : ''})`);
    let video = null;
    if (videoIdSolicitado && !videoIdSolicitado.startsWith('itunes_') && videoIdSolicitado.length === 11) {
      video = {
        videoId: videoIdSolicitado,
        title: titulo,
        seconds: duracionSegundos,
        duracionRef: duracionSegundos,
        author: { name: artista },
        esVerificadoOficial: true
      };
    } else {
      video = await buscarVideoEnYouTube(titulo, artista, duracionSegundos, isrc);
    }

    if (!video) {
      clearTimeout(timeoutGuard);
      return res.status(404).json({ error: true, mensaje: 'Pista oficial de estudio no disponible' });
    }

    video.duracionRef = duracionSegundos || video.seconds || 0;
    video.tituloOriginal = titulo;
    video.artistaOriginal = artista;

    // Priorizar máxima calidad disponible (m4a/AAC nativo o MP3 320k sin re-comprimir)
    let resultadoAudio = await resolverAudioConCascada(video, titulo, 'm4a', { estricto: true });
    if (!resultadoAudio || !resultadoAudio.url) {
      resultadoAudio = await resolverAudioConCascada(video, titulo, 'mp3', { estricto: true });
    }

    if (!resultadoAudio || !resultadoAudio.url) {
      clearTimeout(timeoutGuard);
      return res.status(404).json({ error: true, mensaje: 'Pista oficial de estudio no disponible' });
    }

    const downloadUrl = resultadoAudio.url.replace(/^http:\/\//i, 'https://');
    const response = await axios({
      method: 'get',
      url: downloadUrl,
      responseType: 'stream',
      signal: AbortSignal.timeout(55000),
      timeout: 55000,
      headers: {
        'Referer': 'https://loader.to/',
        'User-Agent': UA,
        'Accept': '*/*'
      },
      maxRedirects: 5,
      validateStatus: () => true
    });

    const ct = (response?.headers?.['content-type'] || '').toLowerCase();
    if (!response || response.status !== 200 || ct.includes('text/html') || ct.includes('application/json') || ct.includes('mpegurl')) {
      clearTimeout(timeoutGuard);
      return res.status(502).json({ error: true, mensaje: 'No se pudo descargar el stream oficial' });
    }

    clearTimeout(timeoutGuard);
    respondido = true;

    const mime = ct.startsWith('audio/') ? ct : (downloadUrl.includes('mime=audio%2Fmp4') || downloadUrl.includes('.m4a') ? 'audio/mp4' : 'audio/mpeg');
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Titulo-Audio', encodeURIComponent(video.title || titulo));
    res.setHeader('X-Calidad-Audio', resultadoAudio.calidad || 'Hi-Fi');
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    streamActivo = response.data;
    streamActivo.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: true, mensaje: 'Error en stream oficial' });
      else res.destroy();
    });
    streamActivo.pipe(res);
  } catch (err) {
    clearTimeout(timeoutGuard);
    console.error('[Error /api/resolver-oficial]:', err.message || err);
    if (!res.headersSent) {
      return res.status(500).json({ error: true, mensaje: 'Error interno al resolver audio oficial' });
    }
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/proxy-stream
// Proxy de streaming con CORS abierto para el navegador y resolución de pista completa
// ---------------------------------------------------------------------------
app.get('/api/proxy-stream', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');

  let audioUrl = (req.query.url || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const busqueda = (req.query.q || req.query.titulo || '').trim();
  const artistaParam = (req.query.artist || req.query.artista || '').trim();

  // Si no se proporciona URL directa pero sí videoId o q, resolver la pista completa
  if (!audioUrl && (videoId || busqueda)) {
    try {
      let video = null;
      if (videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
        video = {
          videoId,
          title: busqueda,
          seconds: parseInt(req.query.seconds) || 0,
          author: { name: artistaParam },
          esVerificadoOficial: true
        };
      } else if (busqueda || artistaParam) {
        video = await buscarVideoEnYouTube(busqueda, artistaParam, parseInt(req.query.seconds) || 0);
        if (!video) {
          const cands = await buscarCandidatosOficiales(busqueda, artistaParam, parseInt(req.query.seconds) || 0);
          if (cands && cands[0]) {
            video = {
              videoId: cands[0].videoId,
              title: cands[0].titulo,
              seconds: cands[0].duracionSeg,
              author: { name: cands[0].canal },
              esVerificadoOficial: true
            };
          }
        }
      }

      if (video) {
        const formato = (req.query.formato || 'mp3').toLowerCase();
        const resCascada = await resolverAudioConCascada(video, busqueda || video.title, formato);
        if (resCascada && resCascada.url) {
          audioUrl = resCascada.url;
          console.log(`[/api/proxy-stream]: Audio completo resuelto vía ${resCascada.proveedor}`);
        }
      }
    } catch (errRes) {
      console.warn('[/api/proxy-stream Error al resolver pista completa]:', errRes.message);
    }
  }

  // Rechazar fragmentos o URLs de preview de 30 segundos solo si NO es una solicitud explícita de vista previa
  const esPeticionPreview = req.query.tipo === 'preview' || req.query.preview === 'true';
  if (!esPeticionPreview && audioUrl && (audioUrl.includes('audio-preview') || audioUrl.includes('m4a-preview') || audioUrl.includes('itunes.apple.com'))) {
    return res.status(403).json({ error: 'Las pistas de vista previa de 30 segundos están deshabilitadas para descarga final' });
  }

  if (!audioUrl) {
    if (videoId || busqueda) {
      return res.status(404).json({ error: 'Audio no disponible temporalmente para esta pista.' });
    }
    return res.status(400).json({ error: 'Debes enviar el parámetro ?url= o ?videoId= o ?q=' });
  }

  // Forzar siempre https para evitar bloqueos por Mixed Active Content
  audioUrl = audioUrl.replace(/^http:\/\//i, 'https://');

  console.log(`\n[/api/proxy-stream]: Transmitiendo stream completo para: ${audioUrl.substring(0, 80)}...`);

  let axiosStream = null;

  res.on('close', () => {
    if (axiosStream && typeof axiosStream.destroy === 'function') {
      axiosStream.destroy();
    }
  });

  const headersAxios = {
    'User-Agent': UA,
    'Accept': '*/*'
  };
  if (audioUrl.includes('googlevideo.com')) {
    headersAxios['Origin'] = 'https://www.youtube.com';
    headersAxios['Referer'] = 'https://www.youtube.com/';
  }
  if (req.headers.range) {
    headersAxios['Range'] = req.headers.range;
  }

  // Petición con soporte de reintento automático y timeout mínimo de 60 segundos
  const intentarProxy = async (urlObjetivo = audioUrl) => {
    return await axios({
      method: 'get',
      url: urlObjetivo,
      responseType: 'stream',
      timeout: 60000,
      headers: headersAxios,
      maxRedirects: 5,
      validateStatus: () => true
    });
  };

  try {
    let response = null;
    try {
      response = await intentarProxy(audioUrl);
    } catch (eInicial) {
      console.warn(`[/api/proxy-stream]: Intento 1 falló (${eInicial.message}), aplicando reintento automático...`);
      await new Promise((r) => setTimeout(r, 600));
      response = await intentarProxy(audioUrl);
    }

    const esEstrictoProxy = req.query.estricto === '1' || req.query.estricto === 'true' || req.query.origen === 'spotify';

    // Si googlevideo.com u otro origen devolvió 403/401/410 y tenemos q/videoId, conmutar a SoundCloud/Audius/IA (solo si NO es modo estricto)
    if (!esEstrictoProxy && (!response || (response.status !== 200 && response.status !== 206)) && (busqueda || artistaParam || videoId)) {
      console.warn(`[/api/proxy-stream]: Origen devolvió HTTP ${response ? response.status : 'error'}. Conmutando a fuentes alternativas...`);
      try {
        const resAlt = await resolverAudioConCascada(
          {
            videoId: '',
            title: busqueda,
            tituloOriginal: busqueda,
            artistaOriginal: artistaParam,
            duracionRef: parseInt(req.query.seconds) || 0,
            author: { name: artistaParam }
          },
          busqueda || artistaParam,
          req.query.formato || 'mp3',
          { omitirProveedores: ['ytdl-native-stream'] }
        );
        if (resAlt && resAlt.url) {
          audioUrl = resAlt.url.replace(/^http:\/\//i, 'https://');
          delete headersAxios['Origin'];
          delete headersAxios['Referer'];
          response = await intentarProxy(audioUrl);
        }
      } catch (eAlt) {
        console.warn('[/api/proxy-stream Fallback]:', eAlt.message);
      }
    }

    if (!response || (response.status !== 200 && response.status !== 206)) {
      return res.status(response ? response.status : 502).json({
        error: `Servidor remoto devolvió HTTP ${response ? response.status : 'desconectado'}`
      });
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    // Si la URL resuelta es una playlist HLS M3U8 de SoundCloud, ensamblar sus segmentos fMP4/MP3 en memoria y entregar el archivo de audio continuo
    if (
      contentTypeRemoto.includes('mpegurl') ||
      audioUrl.includes('playback.media-streaming.soundcloud.cloud') ||
      audioUrl.includes('.m3u8')
    ) {
      try {
        console.log(`[/api/proxy-stream]: Ensamblando playlist HLS SoundCloud en archivo de audio continuo...`);
        const ensamblado = await ensamblarHlsSoundCloudABuffer(audioUrl);
        res.setHeader('Content-Type', ensamblado.mime);
        res.setHeader('Content-Length', ensamblado.buffer.length);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        return res.status(200).send(ensamblado.buffer);
      } catch (errHls) {
        console.warn(`[/api/proxy-stream HLS Muxer Falló]:`, errHls.message);
        return res.status(502).json({ error: 'No se pudo ensamblar el stream HLS' });
      }
    }

    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('text/plain') ||
      contentTypeRemoto.includes('application/json')
    ) {
      console.warn(`[/api/proxy-stream]: Servidor remoto no devolvió audio sino ${contentTypeRemoto}`);
      return res.status(502).json({
        error: 'El origen devolvió una respuesta no válida (HTML o playlist en vez de archivo de audio).'
      });
    }

    const stream = response.data;
    axiosStream = stream;

    const mime = (response.headers['content-type'] && response.headers['content-type'].startsWith('audio/'))
      ? response.headers['content-type']
      : 'audio/mpeg';

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    if (response.headers['content-range']) {
      res.setHeader('Content-Range', response.headers['content-range']);
      res.status(206);
    } else {
      res.status(200);
    }

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }
    if (response.headers['content-disposition']) {
      res.setHeader('Content-Disposition', response.headers['content-disposition']);
    }

    stream.on('error', (err) => {
      console.error('[/api/proxy-stream Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: "Fallo al transmitir stream" });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);

  } catch (error) {
    console.error('[/api/proxy-stream Error Catch]:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'No se pudo conectar con el origen del archivo' });
    }
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT: /api/descargar-cancion
// Descarga directa completa en un solo paso: resuelve y transmite el stream de audio
// ---------------------------------------------------------------------------
app.get('/api/descargar-cancion', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, X-Titulo-Audio, X-Calidad-Audio');

  let respondido = false;
  let streamActivo = null;

  const timeoutGuard = setTimeout(() => {
    if (!respondido && !res.headersSent) {
      respondido = true;
      if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
      return res.status(504).json({
        error: true,
        mensaje: 'Audio no disponible temporalmente (Tiempo de espera agotado >60s)'
      });
    }
  }, 65000);

  const responderError = (status, mensaje) => {
    clearTimeout(timeoutGuard);
    if (!respondido && !res.headersSent) {
      respondido = true;
      if (streamActivo && typeof streamActivo.destroy === 'function') streamActivo.destroy();
      return res.status(status).json({ error: true, mensaje });
    }
  };

  res.on('close', () => {
    clearTimeout(timeoutGuard);
    if (streamActivo && typeof streamActivo.destroy === 'function') {
      streamActivo.destroy();
    }
  });

  const busqueda = (req.query.q || '').trim();
  const videoId = (req.query.videoId || '').trim();
  const duracionSugerida = parseInt(req.query.seconds) || 0;
  const artistaSugerido = (req.query.artist || '').trim();
  const formatoDeseado = (req.query.formato || req.query.calidad || req.query.format || 'mp3').toLowerCase().trim();
  // Modo estricto (importaciones de Spotify y botón 🔄): ignora el videoId del cliente y exige máster oficial verificado
  const modoEstricto = req.query.estricto === '1' || req.query.estricto === 'true' || req.query.forzarOficial === '1' || req.query.forzarOficial === 'true' || req.query.origen === 'spotify';

  if (!busqueda && !videoId) {
    return responderError(400, 'Debes enviar ?q= o ?videoId=');
  }

  console.log(`\n======================================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Solicitud /api/descargar-cancion (${formatoDeseado}): "${busqueda}" (videoId: ${videoId || 'auto'})`);

  if (videoId.startsWith('jamendo:') || videoId.startsWith('ia:')) {
    try {
      const fuente = videoId.startsWith('jamendo:') ? jamendoSource : internetArchiveSource;
      const streamInfo = await fuente.getStream(videoId);
      if (!streamInfo || !streamInfo.downloadUrl) {
        return responderError(404, 'No se encontró enlace de audio con licencia para esta pista.');
      }
      const urlLicencia = streamInfo.downloadUrl.replace(/^http:\/\//i, 'https://');
      const respLic = await axios({
        method: 'get',
        url: urlLicencia,
        responseType: 'stream',
        signal: AbortSignal.timeout(60000),
        timeout: 60000,
        headers: { 'User-Agent': UA, 'Accept': '*/*' },
        maxRedirects: 5,
        validateStatus: () => true
      });
      if (!respLic || respLic.status !== 200) {
        return responderError(respLic ? respLic.status : 502, 'Audio con licencia no disponible temporalmente');
      }
      clearTimeout(timeoutGuard);
      respondido = true;
      const safeTitle = (busqueda || 'pista').replace(/[/\\?%*:|"<>]/g, '_');
      res.setHeader('Content-Type', respLic.headers['content-type'] || 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Titulo-Audio', encodeURIComponent(busqueda || 'pista'));
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);
      if (respLic.headers['content-length']) {
        res.setHeader('Content-Length', respLic.headers['content-length']);
      }
      streamActivo = respLic.data;
      streamActivo.pipe(res);
      return;
    } catch (errCc) {
      return responderError(502, errCc?.message || 'Error descargando fuente con licencia');
    }
  }

  try {
    let video = null;

    if (!modoEstricto && videoId && !videoId.startsWith('itunes_') && videoId.length === 11) {
      video = {
        videoId: videoId,
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido },
        esStubCliente: true
      };
    } else {
      video = await buscarVideoEnYouTube(busqueda, artistaSugerido, duracionSugerida);
      if (video) {
        video.duracionRef = duracionSugerida || video.seconds || 0;
        video.tituloOriginal = busqueda;
        video.artistaOriginal = artistaSugerido;
      }
    }

    if (!video) {
      video = {
        videoId: '',
        seconds: duracionSugerida,
        duracionRef: duracionSugerida,
        title: busqueda,
        tituloOriginal: busqueda,
        artistaOriginal: artistaSugerido,
        author: { name: artistaSugerido },
        esVerificadoOficial: false
      };
    }

    const trackTitle = video.title || busqueda;

    // 1. Resolver enlace mediante la cascada oficial de estudio (Prohibido covers de relleno)
    let resultadoAudio = await resolverAudioConCascada(video, busqueda, formatoDeseado, { estricto: modoEstricto });

    if (!resultadoAudio || !resultadoAudio.url) {
      return responderError(404, 'Audio oficial de estudio no disponible');
    }

    let downloadUrl = resultadoAudio.url.replace(/^http:\/\//i, 'https://');
    console.log(`[Descarga Directa (${resultadoAudio.calidad} / ${resultadoAudio.proveedor})]: Conectando stream...`);

    // Si es un stream HLS de SoundCloud, ensamblar los segmentos directamente en un archivo completo y enviarlo
    if (
      resultadoAudio.esHlsSoundCloud ||
      downloadUrl.includes('playback.media-streaming.soundcloud.cloud') ||
      downloadUrl.includes('.m3u8')
    ) {
      try {
        const ensamblado = await ensamblarHlsSoundCloudABuffer(downloadUrl);
        clearTimeout(timeoutGuard);
        respondido = true;
        const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
        res.setHeader('Content-Type', ensamblado.mime);
        res.setHeader('Content-Length', ensamblado.buffer.length);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
        res.setHeader('X-Calidad-Audio', resultadoAudio.calidad);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);
        return res.status(200).send(ensamblado.buffer);
      } catch (errHlsDesc) {
        console.warn(`[/api/descargar-cancion HLS Muxer Falló]:`, errHlsDesc.message);
      }
    }

    // 2. Conectar y transmitir el stream con timeout de 60 segundos
    async function intentarConectarStream(urlRemota) {
      return await axios({
        method: 'get',
        url: urlRemota,
        responseType: 'stream',
        signal: AbortSignal.timeout(60000),
        timeout: 60000,
        headers: {
          'Referer': 'https://loader.to/',
          'User-Agent': UA,
          'Accept': '*/*'
        },
        maxRedirects: 5,
        validateStatus: () => true
      });
    }

    let response = null;
    try {
      response = await intentarConectarStream(downloadUrl);
    } catch (errAxios) {
      console.warn(`[Stream Error Axios (${resultadoAudio.proveedor})]:`, errAxios.message);
    }

    // Comprobar si el stream de alta calidad falló o saturó
    const esValido = response && response.status === 200 && (() => {
      const ct = (response.headers['content-type'] || '').toLowerCase();
      return !ct.includes('text/html') && !ct.includes('application/json') && !ct.includes('mpegurl');
    })();

    // DEGRADACIÓN ELEGANTE (Downgrade Transparente): Si el proveedor inicial falló, conmutar al siguiente en la cascada
    if (!esValido) {
      console.warn(`[Downgrade Transparente]: Proveedor inicial (${resultadoAudio.proveedor}) saturado o fallido. Conmutando a siguiente proveedor...`);
      try {
        const fallbackAudio = await resolverAudioConCascada(video, busqueda, 'mp3', {
          estricto: modoEstricto,
          omitirProveedores: [resultadoAudio.proveedor]
        });
        if (fallbackAudio && fallbackAudio.url && fallbackAudio.url !== downloadUrl) {
          resultadoAudio = fallbackAudio;
          downloadUrl = fallbackAudio.url.replace(/^http:\/\//i, 'https://');
          if (
            fallbackAudio.esHlsSoundCloud ||
            downloadUrl.includes('playback.media-streaming.soundcloud.cloud') ||
            downloadUrl.includes('.m3u8')
          ) {
            const ensamblado = await ensamblarHlsSoundCloudABuffer(downloadUrl);
            clearTimeout(timeoutGuard);
            respondido = true;
            const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
            res.setHeader('Content-Type', ensamblado.mime);
            res.setHeader('Content-Length', ensamblado.buffer.length);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
            res.setHeader('X-Calidad-Audio', fallbackAudio.calidad);
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.mp3"`);
            return res.status(200).send(ensamblado.buffer);
          }
          response = await intentarConectarStream(downloadUrl);
        }
      } catch (errFallback) {
        console.warn(`[Aviso Downgrade]:`, errFallback.message);
      }
    }

    if (!response || response.status !== 200) {
      return responderError(response ? response.status : 502, 'Audio no disponible temporalmente');
    }

    const contentTypeRemoto = (response.headers['content-type'] || '').toLowerCase();
    if (
      contentTypeRemoto.includes('text/html') ||
      contentTypeRemoto.includes('application/json') ||
      contentTypeRemoto.includes('application/vnd.apple.mpegurl') ||
      contentTypeRemoto.includes('application/x-mpegurl')
    ) {
      return responderError(500, 'Audio no disponible temporalmente');
    }

    clearTimeout(timeoutGuard);
    respondido = true;

    const esVideo = formatoDeseado.includes('360') || formatoDeseado.includes('720') || formatoDeseado.includes('1080') || formatoDeseado.includes('144') || formatoDeseado.includes('240');
    const esM4a = formatoDeseado === 'm4a';

    let mime = 'audio/mpeg';
    let ext = 'mp3';
    if (esVideo) {
      mime = 'video/mp4';
      ext = 'mp4';
    } else if (esM4a) {
      mime = 'audio/mp4';
      ext = 'm4a';
    } else if (response.headers['content-type'] && response.headers['content-type'].startsWith('audio/')) {
      mime = response.headers['content-type'];
    }

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Titulo-Audio', encodeURIComponent(trackTitle));
    res.setHeader('X-Calidad-Audio', resultadoAudio.calidad);

    const safeTitle = trackTitle.replace(/[/\\?%*:|"<>]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeTitle)}.${ext}"`);

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    let axiosStream = response.data;
    streamActivo = axiosStream;

    axiosStream.on('error', (err) => {
      console.error('[/api/descargar-cancion Stream Error]:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: true, mensaje: 'Audio no disponible temporalmente' });
      } else {
        res.destroy();
      }
    });

    axiosStream.pipe(res);

  } catch (error) {
    console.error(`[Error /api/descargar-cancion]:`, error.message || error);
    return responderError(500, 'Audio no disponible temporalmente');
  }
});

// ---------------------------------------------------------------------------
// ENDPOINT 2: /descargar (Fallback de compatibilidad)
// ---------------------------------------------------------------------------
app.get('/descargar', async (req, res) => {
  const busqueda = req.query.q;
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar ?q=' });
  }

  try {
    const consultaBusqueda = `${busqueda} audio oficial`;
    const searchResult = await yts(consultaBusqueda);
    const videos = searchResult && searchResult.videos ? searchResult.videos : [];
    const video = videos.find((v) => v.seconds >= 90 && v.seconds <= 480)
      || videos.find((v) => v.seconds > 60)
      || videos[0];

    if (!video) {
      return res.status(404).json({ error: 'No se encontró el video oficial.' });
    }

    const downloadUrl = await resolverDirectAudioUrl(video, busqueda);
    if (!downloadUrl) {
      return res.status(502).json({ error: 'No se pudo obtener enlace de audio.' });
    }

    // Redireccionar al cliente directamente a la URL de descarga
    return res.redirect(302, downloadUrl);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Rutas de compatibilidad y streaming directo (/api/stream y /stream)
app.get('/api/stream', (req, res) => {
  const videoId = req.query.id || req.query.videoId || '';
  const titulo = req.query.titulo || req.query.q || '';
  const artist = req.query.artist || '';
  const seconds = req.query.seconds || 0;
  const qFinal = `${titulo} ${artist}`.trim();
  return res.redirect(
    307,
    `/api/proxy-stream?videoId=${encodeURIComponent(videoId)}&q=${encodeURIComponent(qFinal)}&seconds=${encodeURIComponent(seconds)}&tipo=preview`
  );
});
app.get('/buscar', (req, res) => res.redirect(307, `/api/obtener-enlace?q=${encodeURIComponent(req.query.q || '')}`));
app.get('/stream', (req, res) => res.redirect(307, `/descargar?q=${encodeURIComponent(req.query.q || '')}`));

// Middleware anti-caché estricto para archivos de control PWA (sw.js, index.html, manifest)
// Esto asegura que los teléfonos y navegadores SIEMPRE reciban la versión más reciente al instante.
app.use((req, res, next) => {
  const ruta = (req.path || '').toLowerCase();
  if (
    ruta === '/sw.js' ||
    ruta === '/index.html' ||
    ruta === '/' ||
    ruta.endsWith('.webmanifest') ||
    ruta.endsWith('manifest.json')
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// Manifiesto ligero OTA para @capawesome/capacitor-live-update (el .zip vive en GitHub Releases)
app.get('/api/ota/version.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.status(200).json({
    version: (process.env.OTA_BUNDLE_VERSION || '5.3.0').trim(),
    bundleUrl: (process.env.OTA_BUNDLE_URL || '').trim(),
    notes: (process.env.OTA_NOTES || '').trim(),
    updatedAt: new Date().toISOString()
  });
});

// Validación de metadatos y duraciones candidatas con MusicBrainz (1 req/s + caché)
app.get('/api/musicbrainz/validate', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();

  if (!title) {
    return res.status(400).json({ ok: false, error: 'Parámetro title requerido' });
  }

  try {
    const resultado = await buscarGrabacionesMusicBrainz(title, artist);
    return res.status(200).json(resultado);
  } catch (err) {
    const status = err?.response?.status || 503;
    return res.status(status >= 400 && status < 600 ? status : 503).json({
      ok: false,
      error: 'No se pudo consultar MusicBrainz en este momento',
      detail: err?.message || String(err)
    });
  }
});

// Servir estáticos de la PWA compilada
app.use(express.static(RUTA_ESTATICOS, {
  setHeaders: (res, pathRes) => {
    const nombre = path.basename(pathRes).toLowerCase();
    const rutaNormalizada = pathRes.replace(/\\/g, '/').toLowerCase();
    if (nombre === 'sw.js' || nombre === 'index.html' || nombre.endsWith('.webmanifest') || nombre.endsWith('.json')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (rutaNormalizada.includes('/assets/') || nombre.endsWith('.js') || nombre.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Fallback SPA/PWA
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }

  // Prevenir que rutas de API desconocidas sirvan index.html
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: true, mensaje: 'Endpoint de API no encontrado' });
  }

  const archivoIndex = path.join(RUTA_ESTATICOS, 'index.html');
  if (fs.existsSync(archivoIndex)) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(archivoIndex);
  }

  res.status(200).json({
    status: 'online',
    servicio: 'Servidor de Música Backend (API)',
    health: '/health',
    puerto: PUERTO,
    endpoints: [
      '/api/buscar-canciones?q=...',
      '/api/descargar-cancion?q=...&videoId=...',
      '/api/obtener-enlace?q=...',
      '/api/proxy-stream?url=...'
    ]
  });
});

if (require.main === module) {
  app.listen(PUERTO, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` Servidor Express Activo en Puerto ${PUERTO}`);
    console.log(` Endpoint Directo: GET /api/obtener-enlace?q=...`);
    console.log(` Descarga realizada directamente por el cliente`);
    console.log(` Aplicación web: http://localhost:${PUERTO}`);
    console.log(`=======================================================`);
  });
}

module.exports = app;