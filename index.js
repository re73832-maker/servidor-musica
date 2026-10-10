const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PUERTO = process.env.PORT || 4000;
const RUTA_DIST = path.join(__dirname, 'dist');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TAMANO_MINIMO = 1024 * 1024;       // 1 MB: menos que esto no es una canción completa
const TAMANO_MAXIMO = 40 * 1024 * 1024;  // 40 MB: límite de seguridad de memoria

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type', 'X-Fuente-Audio', 'X-Titulo-Audio']
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'servidor-musica', port: PUERTO });
});

// ---------------------------------------------------------------------------
// Utilidades de validación
// ---------------------------------------------------------------------------

/** Verifica por "magic bytes" que el buffer sea realmente audio (MP3 / MP4 / WebM / OGG). */
function esAudioReal(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') return true;                 // MP3 con ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;                  // MP3 frame sync / ADTS
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true;                // MP4 / M4A
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true; // WebM
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return true;                // OGG
  return false;
}

/** Detecta el tipo MIME real a partir del contenido. */
function tipoMimeReal(buf) {
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45) return 'audio/webm';
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  return 'audio/mpeg';
}

/**
 * Descarga una URL completa en memoria y la valida estrictamente:
 * status 200, content-type de audio (no JSON/HTML/texto), tamaño > 1 MB y magic bytes de audio.
 * Lanza error si algo no cumple -> el pipeline pasa al siguiente proveedor.
 */
async function descargarYValidar(url, etiqueta) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: TAMANO_MAXIMO,
    headers: { 'User-Agent': UA },
    validateStatus: () => true
  });

  const tipo = String(resp.headers['content-type'] || '').toLowerCase();
  const buf = Buffer.from(resp.data);

  if (resp.status !== 200) throw new Error(`${etiqueta}: HTTP ${resp.status}`);
  if (/json|html|text\//.test(tipo)) throw new Error(`${etiqueta}: content-type inválido (${tipo})`);
  if (buf.length < TAMANO_MINIMO) throw new Error(`${etiqueta}: archivo demasiado pequeño (${buf.length} bytes)`);
  if (!esAudioReal(buf)) throw new Error(`${etiqueta}: el contenido no es audio real`);

  return buf;
}

/** Limpia títulos de YouTube para buscarlos en otros catálogos. */
function limpiarTitulo(t) {
  return String(t || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(official|oficial|video|music|audio|lyrics?|letra|hd|4k|visualizer|en vivo|live)\b/gi, ' ')
    .replace(/[|"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !['ft', 'feat', 'the', 'el', 'la', 'de', 'y'].includes(w));
}

// ---------------------------------------------------------------------------
// Proveedor 1: SoundCloud (API v2 directa, no bloquea IPs de datacenter)
// ---------------------------------------------------------------------------

let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  const html = (await axios.get('https://soundcloud.com/', { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
  const scripts = [...html.matchAll(/<script crossorigin src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
    .map((m) => m[1])
    .reverse();

  for (const src of scripts) {
    try {
      const js = (await axios.get(src, { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
      const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
      if (m) {
        scClientId = m[1];
        scClientIdFecha = Date.now();
        return scClientId;
      }
    } catch (_) {}
  }
  throw new Error('SoundCloud: no se pudo obtener client_id');
}

/** Puntúa un resultado de SoundCloud según coincidencia con la búsqueda. */
function puntuarPista(pista, tokensBusqueda, duracionRef) {
  const texto = `${pista.title} ${pista.user?.username || ''} ${pista.publisher_metadata?.artist || ''}`;
  const tp = new Set(tokens(texto));
  const coincidencias = tokensBusqueda.filter((w) => tp.has(w)).length;
  let puntos = tokensBusqueda.length ? coincidencias / tokensBusqueda.length : 0;

  if (duracionRef) {
    const dif = Math.abs(pista.full_duration / 1000 - duracionRef);
    if (dif < 6) puntos += 0.5;
    else if (dif < 15) puntos += 0.25;
    else if (dif > 40) puntos -= 0.4;
  }
  const alteradas = /remix|cover|karaoke|instrumental|slowed|sped|8d|\bmix\b|edit|tech|filtred|bootleg|rework|flip|mashup|vip|guaracha|dembow|house|version|versión|acapella|tribute|tributo|nightcore|reverb|extended|aleteo|zapateo|dj\b/i;
  const buscaAlterada = tokensBusqueda.some((w) => alteradas.test(w));
  if (!buscaAlterada && alteradas.test(pista.title)) puntos -= 0.6;
  // Bonus si el subidor parece el artista oficial
  const usuario = tokens(pista.user?.username || '');
  if (usuario.length && usuario.every((w) => tokensBusqueda.includes(w))) puntos += 0.3;
  return puntos;
}

async function resolverStreamSoundCloud(pista, clientId) {
  const transcodings = pista.media?.transcodings || [];
  // Preferimos MP3 progresivo (archivo único); si no, HLS MP3 (segmentos concatenables).
  const progresivo = transcodings.find((t) => t.format?.protocol === 'progressive');
  const hlsMp3 = transcodings.find((t) => t.format?.protocol === 'hls' && /mpeg/.test(t.format?.mime_type || ''));

  const params = { client_id: clientId, track_authorization: pista.track_authorization };

  if (progresivo) {
    const r = await axios.get(progresivo.url, { params, headers: { 'User-Agent': UA }, timeout: 10000 });
    if (r.data?.url) return descargarYValidar(r.data.url, 'SoundCloud progresivo');
  }

  if (hlsMp3) {
    const r = await axios.get(hlsMp3.url, { params, headers: { 'User-Agent': UA }, timeout: 10000 });
    if (!r.data?.url) throw new Error('SoundCloud HLS: sin URL');
    const playlist = (await axios.get(r.data.url, { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
    const segmentos = String(playlist).split('\n').filter((l) => l && !l.startsWith('#'));
    const partes = [];
    let total = 0;
    for (const seg of segmentos) {
      const s = await axios.get(seg, { responseType: 'arraybuffer', headers: { 'User-Agent': UA }, timeout: 20000 });
      const b = Buffer.from(s.data);
      total += b.length;
      if (total > TAMANO_MAXIMO) throw new Error('SoundCloud HLS: excede tamaño máximo');
      partes.push(b);
    }
    const buf = Buffer.concat(partes);
    if (buf.length < TAMANO_MINIMO || !esAudioReal(buf)) throw new Error('SoundCloud HLS: audio inválido');
    return buf;
  }

  throw new Error('SoundCloud: la pista no tiene stream MP3 disponible');
}

async function proveedorSoundCloud(consultas, duracionRef) {
  let clientId = await obtenerClientIdSoundCloud();
  const tokensBusqueda = tokens(consultas[0]);
  const candidatos = new Map();

  for (const q of consultas) {
    let r;
    try {
      r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
        params: { q, client_id: clientId, limit: 15 },
        headers: { 'User-Agent': UA },
        timeout: 10000
      });
    } catch (e) {
      if (e.response?.status === 401 || e.response?.status === 403) {
        clientId = await obtenerClientIdSoundCloud(true);
        r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
          params: { q, client_id: clientId, limit: 15 },
          headers: { 'User-Agent': UA },
          timeout: 10000
        });
      } else {
        throw e;
      }
    }
    for (const p of r.data?.collection || []) candidatos.set(p.id, p);
  }

  const validos = [...candidatos.values()]
    .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')          // sin previews de 30s ni bloqueadas
    .filter((p) => p.full_duration > 60000)                               // canciones completas (> 60s)
    .filter((p) => Math.abs(p.duration - p.full_duration) < 5000)         // duración reproducible = completa
    .map((p) => ({ p, puntos: puntuarPista(p, tokensBusqueda, duracionRef) }))
    .sort((a, b) => b.puntos - a.puntos);

  console.log(`  [SoundCloud] ${candidatos.size} resultados, ${validos.length} completos. Top: ` +
    validos.slice(0, 3).map((v) => `"${v.p.title}" (${v.puntos.toFixed(2)})`).join(' | '));

  for (const { p, puntos } of validos.slice(0, 6)) {
    try {
      console.log(`  [SoundCloud] Probando "${p.title}" de ${p.user?.username} (puntos ${puntos.toFixed(2)})`);
      const buf = await resolverStreamSoundCloud(p, clientId);
      return { buffer: buf, titulo: p.title, fuente: 'soundcloud' };
    } catch (e) {
      console.warn(`  [SoundCloud] Descartada: ${e.message}`);
    }
  }
  throw new Error('SoundCloud: ninguna pista válida');
}

// ---------------------------------------------------------------------------
// Proveedor 2: Piped / Invidious (stream directo, validado)
// ---------------------------------------------------------------------------

async function proveedorPipedInvidious(videoId) {
  const piped = ['https://pipedapi.kavin.rocks', 'https://pipedapi.leptons.xyz', 'https://pipedapi.adminforge.de'];
  for (const host of piped) {
    try {
      const r = await axios.get(`${host}/streams/${videoId}`, { timeout: 6000, headers: { 'User-Agent': UA } });
      const mejor = (r.data?.audioStreams || []).filter((a) => a.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (mejor) {
        const buf = await descargarYValidar(mejor.url, `Piped ${host}`);
        return { buffer: buf, titulo: r.data.title, fuente: 'piped' };
      }
    } catch (e) {
      console.warn(`  [Piped] ${host}: ${e.message}`);
    }
  }

  const invidious = ['https://invidious.f5.si', 'https://inv.nadeko.net', 'https://yewtu.be'];
  for (const host of invidious) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, { timeout: 6000, headers: { 'User-Agent': UA } });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor = formatos.find((f) => String(f.itag) === '140') || formatos[0];
      if (mejor) {
        const buf = await descargarYValidar(mejor.url, `Invidious ${host}`);
        return { buffer: buf, titulo: r.data.title, fuente: 'invidious' };
      }
    } catch (e) {
      console.warn(`  [Invidious] ${host}: ${e.message}`);
    }
  }
  throw new Error('Piped/Invidious: ninguna instancia entregó audio válido');
}

// ---------------------------------------------------------------------------
// Proveedor 3: Cobalt (solo acepta status tunnel/redirect)
// ---------------------------------------------------------------------------

async function proveedorCobalt(videoUrl) {
  const instancias = ['https://api.cobalt.tools/'];
  for (const api of instancias) {
    try {
      const r = await axios.post(api, { url: videoUrl, downloadMode: 'audio', audioFormat: 'mp3' }, {
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
        timeout: 8000,
        validateStatus: () => true
      });
      if ((r.data?.status === 'tunnel' || r.data?.status === 'redirect') && r.data.url) {
        const buf = await descargarYValidar(r.data.url, `Cobalt ${api}`);
        return { buffer: buf, titulo: null, fuente: 'cobalt' };
      }
      console.warn(`  [Cobalt] ${api}: respuesta ${r.data?.status || r.status} ${r.data?.error?.code || ''}`);
    } catch (e) {
      console.warn(`  [Cobalt] ${api}: ${e.message}`);
    }
  }
  throw new Error('Cobalt: sin stream válido');
}

// ---------------------------------------------------------------------------
// Endpoint principal
// ---------------------------------------------------------------------------

async function manejarDescargaAudio(req, res) {
  const busqueda = String(req.query.q || '').trim();
  if (!busqueda) {
    return res.status(400).json({ error: 'Debes enviar el nombre de una canción en el parámetro ?q=' });
  }

  console.log(`\n==================================================`);
  console.log(`[${new Date().toLocaleTimeString()}] Descarga solicitada: "${busqueda}"`);

  // Referencia canónica desde YouTube (solo búsqueda de metadatos, no descarga)
  let video = null;
  try {
    const r = await yts(busqueda);
    video = (r.videos || []).find((v) => v.seconds > 60) || null;
    if (video) console.log(`[Referencia] "${video.title}" (${video.seconds}s) ${video.videoId}`);
  } catch (e) {
    console.warn(`[Referencia] yt-search falló: ${e.message}`);
  }

  const consultas = [busqueda];
  if (video) {
    const limpio = limpiarTitulo(video.title);
    if (limpio && limpio.toLowerCase() !== busqueda.toLowerCase()) consultas.unshift(limpio);
  }

  const proveedores = [
    { nombre: 'SoundCloud', fn: () => proveedorSoundCloud(consultas, video?.seconds) },
    ...(video ? [
      { nombre: 'Piped/Invidious', fn: () => proveedorPipedInvidious(video.videoId) },
      { nombre: 'Cobalt', fn: () => proveedorCobalt(video.url) }
    ] : [])
  ];

  for (const prov of proveedores) {
    if (res.writableEnded || req.socket.destroyed) return;
    try {
      console.log(`[Proveedor] ${prov.nombre}...`);
      const { buffer, titulo, fuente } = await prov.fn();
      const tipo = tipoMimeReal(buffer);

      console.log(`[DESCARGA EXITOSA] ${fuente}: ${(buffer.length / 1048576).toFixed(2)} MB (${tipo}). Enviando al cliente.`);
      res.setHeader('Content-Type', tipo);
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(busqueda)}.${tipo === 'audio/mp4' ? 'm4a' : 'mp3'}"`);
      res.setHeader('X-Fuente-Audio', fuente);
      if (titulo) res.setHeader('X-Titulo-Audio', encodeURIComponent(titulo));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(buffer);
    } catch (e) {
      console.warn(`[Proveedor] ${prov.nombre} falló: ${e.message}`);
    }
  }

  console.error(`[FALLO TOTAL] Ningún proveedor entregó audio válido para "${busqueda}"`);
  if (!res.headersSent) {
    return res.status(502).json({ error: 'No se pudo obtener el flujo de audio de ningún proveedor' });
  }
}

app.get('/descargar', manejarDescargaAudio);
app.get('/buscar', manejarDescargaAudio);
app.get('/stream', manejarDescargaAudio);

// Frontend estático
app.use(express.static(RUTA_DIST));

// Fallback SPA/PWA
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const archivoIndex = path.join(RUTA_DIST, 'index.html');
  if (fs.existsSync(archivoIndex)) return res.sendFile(archivoIndex);
  res.status(404).send('No se encontró el archivo index.html en dist');
});

if (require.main === module) {
  app.listen(PUERTO, '0.0.0.0', () => {
    console.log(`=======================================================`);
    console.log(` Servidor Express activo en puerto ${PUERTO}`);
    console.log(` Motor: SoundCloud API -> Piped/Invidious -> Cobalt`);
    console.log(` Validación: HTTP 200 + content-type audio + >1 MB + magic bytes`);
    console.log(`=======================================================`);
  });
}

module.exports = app;