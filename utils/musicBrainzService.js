const axios = require('axios');

const MUSICBRAINZ_URL = 'https://musicbrainz.org/ws/2/recording';
const USER_AGENT = 'APP_Musica/5.1.0 (https://app-musica.local; offline-library-validator)';
const MIN_INTERVAL_MS = 1050; // Límite estricto: 1 petición por segundo
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const MAX_CACHE_ENTRIES = 1000;

const cacheResultados = new Map();
let ultimoRequestMs = 0;
let colaPromesas = Promise.resolve();

function normalizarTexto(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function limpiarTituloParaBusqueda(titulo) {
  return String(titulo || '')
    .replace(/\([^)]*(official|video|audio|lyric|letra|hd|4k|en vivo|live|visualizer)[^)]*\)/gi, '')
    .replace(/\[[^\]]*(official|video|audio|lyric|letra|hd|4k|en vivo|live|visualizer)[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function crearClaveCache(title, artist) {
  return `${normalizarTexto(title)}|${normalizarTexto(artist)}`;
}

function obtenerDeCache(clave) {
  const entry = cacheResultados.get(clave);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cacheResultados.delete(clave);
    return null;
  }
  return entry.data;
}

function guardarEnCache(clave, data) {
  if (cacheResultados.size >= MAX_CACHE_ENTRIES) {
    const primeraClave = cacheResultados.keys().next().value;
    if (primeraClave) cacheResultados.delete(primeraClave);
  }
  cacheResultados.set(clave, {
    timestamp: Date.now(),
    data
  });
}

function encolarConRateLimit(fn) {
  const tarea = colaPromesas.then(async () => {
    const ahora = Date.now();
    const transcurrido = ahora - ultimoRequestMs;
    if (transcurrido < MIN_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - transcurrido));
    }
    ultimoRequestMs = Date.now();
    return fn();
  });

  // Evitar que un fallo en una tarea rompa la cadena de la cola
  colaPromesas = tarea.catch(() => {});
  return tarea;
}

function escaparLucene(texto) {
  return String(texto || '').replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1').trim();
}

function extraerCandidatos(recordings) {
  if (!Array.isArray(recordings)) return [];
  const candidatos = [];
  const vistos = new Set();

  for (const rec of recordings) {
    if (!rec || typeof rec.length !== 'number' || rec.length <= 0) continue;
    const durationSec = Math.round(rec.length / 1000);
    if (durationSec <= 0) continue;

    const artistCredit = Array.isArray(rec['artist-credit'])
      ? rec['artist-credit'].map((ac) => ac?.name || ac?.artist?.name || '').filter(Boolean).join(', ')
      : '';
    const releaseTitle = Array.isArray(rec.releases) && rec.releases[0] ? rec.releases[0].title : undefined;
    const disambiguation = rec.disambiguation || undefined;

    const dedupKey = `${rec.title || ''}|${durationSec}|${disambiguation || ''}`;
    if (vistos.has(dedupKey)) continue;
    vistos.add(dedupKey);

    candidatos.push({
      id: rec.id,
      title: rec.title || '',
      artist: artistCredit,
      durationSec,
      disambiguation,
      releaseTitle
    });

    if (candidatos.length >= 10) break;
  }

  return candidatos;
}

async function buscarGrabacionesMusicBrainz(title, artist) {
  const tituloLimpio = limpiarTituloParaBusqueda(title);
  const artistaLimpio = String(artist || '').trim();
  if (!tituloLimpio) {
    return { ok: true, found: false, candidates: [], cached: false };
  }

  const clave = crearClaveCache(tituloLimpio, artistaLimpio);
  const enCache = obtenerDeCache(clave);
  if (enCache) {
    return { ...enCache, cached: true };
  }

  const queryParts = [`recording:"${escaparLucene(tituloLimpio)}"`];
  if (artistaLimpio && normalizarTexto(artistaLimpio) !== 'artista desconocido') {
    queryParts.push(`artist:"${escaparLucene(artistaLimpio)}"`);
  }
  const query = queryParts.join(' AND ');

  const respuesta = await encolarConRateLimit(async () => {
    return axios.get(MUSICBRAINZ_URL, {
      params: {
        query,
        fmt: 'json',
        limit: 15
      },
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      timeout: 8000
    });
  });

  const recordings = respuesta?.data?.recordings || [];
  const candidates = extraerCandidatos(recordings);

  const resultado = {
    ok: true,
    found: candidates.length > 0,
    query,
    candidates,
    cached: false
  };

  guardarEnCache(clave, resultado);
  return resultado;
}

module.exports = {
  buscarGrabacionesMusicBrainz
};
