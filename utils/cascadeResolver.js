const axios = require('axios');
const yts = require('yt-search');
const { Ytdl } = require('@distube/ytdl-core');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ytdlInstance = new Ytdl();

// Helper seguro para AbortSignal.timeout
function getTimeoutSignal(ms = 10000) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`Timeout de ${ms}ms alcanzado`)), ms).unref();
  return controller.signal;
}

// Normalizador de formato deseado
function normalizarFormato(formato) {
  if (!formato) return 'mp3';
  const f = formato.toLowerCase().trim();
  if (f === 'm4a') return 'm4a';
  if (f.includes('720') || f.includes('hd')) return '720';
  if (f.includes('1080')) return '1080';
  if (f.includes('360') || f.includes('240') || f.includes('144')) return '360';
  return 'mp3';
}

// ---------------------------------------------------------------------------
// FILTRO DISCOGRÁFICO ESTRICTO ANTI-COVERS Y PRIORIDAD DE AUDIO ORIGINAL DE ESTUDIO
// ---------------------------------------------------------------------------
const PALABRAS_LISTA_NEGRA_ESTRICTA = [
  'cover',
  'karaoke',
  'instrumental',
  'tribute',
  'tributo',
  'nightcore',
  'sped up',
  'slowed',
  '8d',
  'parodia',
  'acústico',
  'acustico',
  'acoustic',
  'session',
  'live',
  'en vivo',
  'fan',
  'version',
  'versión',
  'letra',
  'lyrics',
  'remix',
  'bootleg',
  'mashup',
  'reverb',
  'tutorial',
  'ai cover',
  'imitacion',
  'imitación'
];

function normalizarTextoSimple(txt = '') {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Limpia paréntesis, corchetes y featuring secundarios de un título
 * Ej: "Canción (feat. Otro) [Remastered]" -> "Canción"
 */
function limpiarTituloParaRescate(titulo = '') {
  return String(titulo || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring|con|with)\s+[^-–—|]+$/i, ' ')
    .replace(/\s*[-–—|]\s*(remastered|version|edit|mix|mono|stereo|deluxe|bonus).*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Separa título y artista limpios y construye las 3 consultas discográficas obligatorias en orden:
 * 1) "Provided to YouTube by" "${titulo}" "${artista}"
 * 2) "${titulo}" "${artista} - Topic"
 * 3) "${artista}" "${titulo}" "Official Audio"
 */
function construirConsultasOriginalYRescate(tituloRaw = '', artistaRaw = '') {
  let titulo = String(tituloRaw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let artista = String(artistaRaw || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!artista && titulo.includes(' - ')) {
    const partes = titulo.split(' - ').map((p) => p.trim()).filter(Boolean);
    if (partes.length >= 2) {
      artista = partes[0];
      titulo = partes.slice(1).join(' ');
    }
  } else if (artista && titulo.toLowerCase().endsWith(` - ${artista.toLowerCase()}`)) {
    titulo = titulo.slice(0, titulo.length - (` - ${artista}`).length).trim();
  } else if (artista && titulo.toLowerCase().startsWith(`${artista.toLowerCase()} - `)) {
    titulo = titulo.slice((`${artista} - `).length).trim();
  }

  const tituloLimpio = limpiarTituloParaRescate(titulo) || titulo;
  const artistaPrincipal =
    artista
      .split(/,|;|\/|&|\bfeat\.?\b|\bft\.?\b|\bx\b/i)[0]
      .replace(/\u00a0/g, ' ')
      .trim() || artista;

  const consultasDiscograficas = artistaPrincipal
    ? [
        `"Provided to YouTube by" "${tituloLimpio}" "${artistaPrincipal}"`,
        `"${tituloLimpio}" "${artistaPrincipal} - Topic"`,
        `"${artistaPrincipal}" "${tituloLimpio}" "Official Audio"`
      ]
    : [
        `"Provided to YouTube by" "${tituloLimpio}"`,
        `"${tituloLimpio}" "Official Audio"`
      ];

  const consultaOriginal = consultasDiscograficas[1] || consultasDiscograficas[0];
  const consultaRescate = consultasDiscograficas[2] || `${artistaPrincipal} ${tituloLimpio} Official Audio`.trim();

  return {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultasDiscograficas,
    consultaOriginal,
    consultaRescate
  };
}

/**
 * Filtro de Autor/Canal Obligatorio:
 * DESCARTA DE INMEDIATO cualquier video cuyo canal (author.name) NO cumpla al menos una de estas condiciones:
 * 1) Termina en " - Topic" (canal autogenerado por la disquera).
 * 2) Contiene "VEVO" o "Official" / "Oficial".
 * 3) El nombre del canal contiene exactamente el nombre del artista principal (artista.toLowerCase()).
 */
function esCanalAutorOficialValido(autorRaw = '', artistaOriginal = '') {
  const autor = String(autorRaw || '').replace(/\u00a0/g, ' ').trim();
  if (!autor) return false;

  const autorLower = autor.toLowerCase();
  const autorNorm = normalizarTextoSimple(autor);

  // Condición 1: Termina en " - Topic" (o canal Topic autogenerado por YouTube Music / disquera)
  if (/-\s*topic$/i.test(autor) || /\btopic$/i.test(autor)) {
    return true;
  }

  // Condición 2: Contiene "VEVO" o "Official" / "Oficial"
  if (/\b(vevo|official|oficial)\b/i.test(autorLower)) {
    return true;
  }

  // Condición 3: El nombre del canal contiene exactamente el nombre del artista principal
  const listaArtistas = String(artistaOriginal || '')
    .replace(/\u00a0/g, ' ')
    .split(/,|;|\/|&|\bfeat\.?\b|\bft\.?\b/i)
    .map((a) => a.trim())
    .filter((a) => a.length >= 2);

  for (const art of listaArtistas) {
    const artLower = art.toLowerCase();
    const artNorm = normalizarTextoSimple(art);
    if (artLower && autorLower.includes(artLower)) {
      return true;
    }
    if (artNorm && artNorm.length >= 3 && autorNorm.includes(artNorm)) {
      return true;
    }
  }

  return false;
}

/**
 * Lista Negra Estricta:
 * Rechaza cualquier resultado cuyo título o canal contenga:
 * cover, karaoke, instrumental, tribute, tributo, nightcore, sped up, slowed, 8d,
 * parodia, acústico, acoustic, session, live, en vivo, fan, version, letra, lyrics
 * (a menos que el título original de Spotify contenga explícitamente esa palabra).
 */
function esResultadoEnListaNegra(tituloCandidato = '', autorCandidato = '', tituloOriginalSpotify = '') {
  const origNorm = ` ${normalizarTextoSimple(tituloOriginalSpotify)} `;
  const candTexto = `${tituloCandidato || ''} ${autorCandidato || ''}`;
  const candNorm = ` ${normalizarTextoSimple(candTexto)} `;

  for (const palabra of PALABRAS_LISTA_NEGRA_ESTRICTA) {
    const palNorm = normalizarTextoSimple(palabra);
    if (!palNorm) continue;
    const regexPalabra = new RegExp(`\\b${palNorm.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (regexPalabra.test(candNorm) || regexPalabra.test(candTexto)) {
      // Verificar si el título original de Spotify contiene explícitamente esa palabra
      if (!regexPalabra.test(origNorm) && !regexPalabra.test(tituloOriginalSpotify || '')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Evalúa de forma estricta un candidato para asegurar que sea EXCLUSIVAMENTE
 * la grabación oficial de estudio del artista original.
 */
function evaluarCandidatoOriginal({
  tituloCandidato = '',
  autorCandidato = '',
  descripcionCandidato = '',
  duracionSegsCandidato = 0,
  tituloOriginal = '',
  artistaOriginal = '',
  duracionRefSegs = 0,
  toleranciaMaxSegs = 10
}) {
  const canalValido = esCanalAutorOficialValido(autorCandidato, artistaOriginal);
  const enListaNegra = esResultadoEnListaNegra(tituloCandidato, autorCandidato, tituloOriginal);

  // Validación de Duración Exacta: Si Spotify proporcionó duracionSegundos > 0,
  // rechaza cualquier resultado cuya duración difiera en más de ±10 segundos.
  const tieneDuracionSpotify = duracionRefSegs > 0;
  const diffSegs =
    tieneDuracionSpotify && duracionSegsCandidato > 0
      ? Math.abs(duracionSegsCandidato - duracionRefSegs)
      : 0;
  const dentroToleranciaDuracion =
    !tieneDuracionSpotify ||
    (duracionSegsCandidato > 0 && diffSegs <= toleranciaMaxSegs);

  const normTituloCand = normalizarTextoSimple(tituloCandidato);
  const normAutorCand = normalizarTextoSimple(autorCandidato);
  const normTituloOrig = normalizarTextoSimple(limpiarTituloParaRescate(tituloOriginal) || tituloOriginal);
  const palabrasTitulo = normTituloOrig.split(' ').filter((w) => w.length >= 2);
  const palabrasCoincidentes = palabrasTitulo.filter((w) => normTituloCand.includes(w));
  const coincideTitulo =
    !normTituloOrig ||
    normTituloCand.includes(normTituloOrig) ||
    (palabrasTitulo.length > 0 && palabrasCoincidentes.length >= Math.ceil(palabrasTitulo.length * 0.7));

  const esTopicDisquera =
    /-\s*topic$/i.test(String(autorCandidato || '').trim()) ||
    /provided to youtube by/i.test(descripcionCandidato || '');
  const esVevoOficial = /\b(vevo|official|oficial)\b/i.test(autorCandidato || '');
  const esOfficialAudioTitle = /\b(official\s*audio|audio\s*oficial)\b/i.test(tituloCandidato || '');

  const esAutenticoEstudio =
    canalValido &&
    !enListaNegra &&
    dentroToleranciaDuracion &&
    coincideTitulo;

  let penalizacion = diffSegs * 1000;
  if (!canalValido) penalizacion += 1000000;
  if (enListaNegra) penalizacion += 1000000;
  if (!dentroToleranciaDuracion) penalizacion += 500000 + diffSegs * 5000;
  if (!coincideTitulo) penalizacion += 200000;

  // Premiar grabaciones directas de disquera (" - Topic" / "Provided to YouTube by") sobre videoclips con intro hablada
  if (esTopicDisquera) penalizacion -= 25000;
  if (esOfficialAudioTitle) penalizacion -= 15000;
  if (esVevoOficial) penalizacion -= 8000;
  if (normAutorCand && artistaOriginal && normAutorCand.includes(normalizarTextoSimple(artistaOriginal.split(',')[0]))) {
    penalizacion -= 6000;
  }

  return {
    esAutenticoEstudio,
    canalValido,
    enListaNegra,
    dentroToleranciaDuracion,
    coincideTitulo,
    esTopicDisquera,
    diffSegs,
    penalizacion
  };
}

// ---------------------------------------------------------------------------
// NIVEL 1: SoundCloud Direct Progressive + HLS fMP4 Muxer (Funciona 100% en Render sin bloqueos)
// ---------------------------------------------------------------------------
let scClientId = null;
let scClientIdFecha = 0;

async function obtenerClientIdSoundCloud(forzar = false) {
  if (!forzar && scClientId && Date.now() - scClientIdFecha < 6 * 60 * 60 * 1000) return scClientId;

  try {
    const html = (await axios.get('https://soundcloud.com/', {
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000
    })).data;

    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('sndcdn.com'))
      .reverse();

    for (const src of scripts.slice(0, 6)) {
      try {
        const js = (await axios.get(src, {
          headers: { 'User-Agent': UA },
          signal: getTimeoutSignal(5000),
          timeout: 5000
        })).data;
        const m = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/) || js.match(/client_id=([a-zA-Z0-9]{32})/);
        if (m) {
          scClientId = m[1];
          scClientIdFecha = Date.now();
          return scClientId;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

/**
 * Descarga y ensambla una playlist HLS de SoundCloud (fMP4 AAC 160k o MP3) en un único Buffer de audio continuo
 */
async function ensamblarHlsSoundCloudABuffer(m3u8Url) {
  const m3u8Res = await axios.get(m3u8Url, {
    headers: { 'User-Agent': UA },
    signal: getTimeoutSignal(10000),
    timeout: 10000
  });

  const m3u8Text = String(m3u8Res.data || '');
  if (!m3u8Text.includes('#EXTM3U')) {
    throw new Error('Playlist M3U8 inválida');
  }

  const mapMatch = m3u8Text.match(/#EXT-X-MAP:URI="([^"]+)"/);
  const segUrls = m3u8Text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('http://') || l.startsWith('https://'));

  const todasLasUrls = mapMatch && mapMatch[1] ? [mapMatch[1], ...segUrls] : segUrls;
  if (todasLasUrls.length === 0) {
    throw new Error('Playlist M3U8 sin segmentos');
  }

  // Descargar segmentos en lotes paralelos de 8 para máxima velocidad (~1.5s total)
  const LOTE = 8;
  const buffers = [];
  for (let i = 0; i < todasLasUrls.length; i += LOTE) {
    const grupo = todasLasUrls.slice(i, i + LOTE);
    const descargados = await Promise.all(
      grupo.map((u) =>
        axios
          .get(u, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(12000),
            timeout: 12000
          })
          .then((r) => Buffer.from(r.data))
      )
    );
    buffers.push(...descargados);
  }

  const bufferCompleto = Buffer.concat(buffers);
  const esMp4 = Boolean(mapMatch && mapMatch[1]);
  return {
    buffer: bufferCompleto,
    mime: esMp4 ? 'audio/mp4' : 'audio/mpeg'
  };
}

async function probarSoundCloud(busqueda, duracionRef, metaOriginal = {}) {
  try {
    let clientId = await obtenerClientIdSoundCloud();
    if (!clientId) clientId = await obtenerClientIdSoundCloud(true);
    if (!clientId) return null;

    const tituloOrig = metaOriginal.titulo || busqueda;
    const artistaOrig = metaOriginal.artista || '';
    const toleranciaSegs = metaOriginal.toleranciaSegs || 18;

    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: busqueda, client_id: clientId, limit: 20 },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(8000),
      timeout: 8000,
      validateStatus: (status) => status === 200
    });

    const coleccion = (r.data?.collection || [])
      .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
      .filter((p) => p.full_duration >= 45000 && p.full_duration <= 900000);

    if (!coleccion.length) return null;

    // Filtrar pistas que tengan al menos un transcoding NO encriptado (progressive o hls estándar)
    const pistasReproducibles = coleccion.filter((p) => {
      const trans = p.media?.transcodings || [];
      return trans.some(
        (t) =>
          t.format?.protocol === 'progressive' ||
          (t.format?.protocol === 'hls' && !String(t.format?.mime_type || '').includes('mpegurl'))
      );
    });

    if (!pistasReproducibles.length) return null;

    // Evaluar cada pista con el filtro estricto anti-covers y duración ±18s
    const evaluadas = pistasReproducibles.map((p) => {
      const durSegs = Math.round((p.full_duration || 0) / 1000);
      const autorSc = p.user?.username || p.publisher_metadata?.artist || '';
      const ev = evaluarCandidatoOriginal({
        tituloCandidato: p.title || '',
        autorCandidato: autorSc,
        duracionSegsCandidato: durSegs,
        tituloOriginal: tituloOrig,
        artistaOriginal: artistaOrig,
        duracionRefSegs: duracionRef,
        toleranciaMaxSegs: toleranciaSegs
      });
      return { pista: p, ev };
    });

    // Descartar automáticamente resultados en lista negra (covers, karaoke, 8d, slowed, etc.)
    // y si Spotify envió duracionRef (>30s), exigir que la duración no difiera en más de ±toleranciaSegs (±18s)
    const candidatasValidas = evaluadas.filter((item) => {
      if (item.ev.enListaNegra) return false;
      if (duracionRef && duracionRef > 30 && !item.ev.dentroToleranciaDuracion) return false;
      return true;
    });

    if (!candidatasValidas.length) {
      console.log(`[Filtro Anti-Covers SoundCloud]: Se descartaron ${evaluadas.length} resultados por ser covers o diferir >±${toleranciaSegs}s de la duración original (${duracionRef}s)`);
      return null;
    }

    candidatasValidas.sort((a, b) => a.ev.penalizacion - b.ev.penalizacion);

    // Recorrer pistas en orden de fidelidad (la canción original exacta del artista primero)
    for (const { pista, ev } of candidatasValidas) {
      const trans = pista.media?.transcodings || [];

      // 1. Si esta pista tiene progressive directo, usarlo
      const progresivo = trans.find((t) => t.format?.protocol === 'progressive');
      if (progresivo) {
        try {
          const streamInfo = await axios.get(progresivo.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(6000),
            timeout: 6000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            console.log(`[SoundCloud Progressive Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s, diff: ${ev.diffSegs}s)`);
            return {
              url: streamInfo.data.url.replace(/^http:\/\//i, 'https://'),
              calidad: '160k',
              nivel: 1,
              proveedor: 'SoundCloud-Progressive'
            };
          }
        } catch (_) {}
      }

      // 2. Si esta pista tiene HLS estándar no encriptado (MP3 o fMP4 AAC 160k), usarlo
      const hlsMp3 = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mpeg') && !String(t.format?.mime_type || '').includes('mpegurl')
      );
      const hlsAac = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mp4')
      );
      const elegido = hlsMp3 || hlsAac;
      if (elegido) {
        try {
          const streamInfo = await axios.get(elegido.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(6000),
            timeout: 6000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            const m3u8Url = streamInfo.data.url.replace(/^http:\/\//i, 'https://');
            console.log(`[SoundCloud HLS Éxito]: "${pista.title}" (${Math.round(pista.full_duration / 1000)}s, diff: ${ev.diffSegs}s, ${elegido.format?.mime_type})`);
            return {
              url: m3u8Url,
              esHlsSoundCloud: true,
              calidad: '160k',
              nivel: 1,
              proveedor: 'SoundCloud-HLS'
            };
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('[SoundCloud Aviso]:', e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 2: Extractor nativo @distube/ytdl-core (Directo de YouTube)
// ---------------------------------------------------------------------------
async function resolverNativoYtdl(videoUrl) {
  try {
    console.log(`[Nivel 2 Nativo]: Extrayendo formatos con @distube/ytdl-core...`);
    const info = await Promise.race([
      ytdlInstance.getInfo(videoUrl, {
        requestOptions: {
          headers: { 'User-Agent': UA }
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout ytdl.getInfo 8s')), 8000))
    ]);

    if (!info || !Array.isArray(info.formats) || info.formats.length === 0) {
      return null;
    }

    const audioFormats = info.formats.filter((f) => f.hasAudio && f.url);
    if (audioFormats.length === 0) return null;

    const audioOnly = audioFormats.filter((f) => !f.hasVideo);
    const lista = audioOnly.length > 0 ? audioOnly : audioFormats;

    lista.sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));
    const mejorFormato = lista[0];

    if (mejorFormato && mejorFormato.url) {
      const bitrate = mejorFormato.audioBitrate || 128;
      console.log(`[Nivel 2 Éxito]: Stream nativo resuelto (${bitrate} kbps)`);
      return {
        url: mejorFormato.url,
        calidad: `${bitrate}k`,
        nivel: 2,
        proveedor: 'ytdl-native-stream'
      };
    }
  } catch (err) {
    console.warn(`[Nivel 2 Aviso]: ytdl-core no pudo extraer enlace:`, err.message || err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 3: Loader / Savenow (Solo si no devuelve api_key_required)
// ---------------------------------------------------------------------------
async function probarLoaderSavenow(videoUrl, formato) {
  const dominios = [
    'https://p.savenow.to',
    'https://loader.to',
    'https://p.lbserver.xyz'
  ];

  for (const dominio of dominios) {
    try {
      const startRes = await axios.get(`${dominio}/api/v2/download`, {
        params: { button: 1, format: formato, url: videoUrl },
        headers: { 'User-Agent': UA, 'Referer': 'https://en.loader.to/' },
        signal: getTimeoutSignal(5000),
        timeout: 5000,
        validateStatus: (status) => status === 200
      });

      if (!startRes.data || startRes.data.error_code === 'api_key_required' || !startRes.data.id) {
        break;
      }

      const progressUrl = startRes.data.progress_url || `${dominio}/api/progress?id=${startRes.data.id}`;

      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 700));
        try {
          const pRes = await axios.get(progressUrl, {
            headers: { 'User-Agent': UA, 'Referer': 'https://en.loader.to/' },
            signal: getTimeoutSignal(4000),
            timeout: 4000,
            validateStatus: (status) => status === 200
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
            console.log(`[Nivel 3 Éxito]: Loader/Savenow (${dominio}) en intento ${i + 1}`);
            return {
              url: httpsLink,
              calidad: '320k',
              nivel: 3,
              proveedor: 'Loader.to'
            };
          }

          if (pData.text && pData.text.toLowerCase().includes('error')) break;
        } catch (_) {}
      }
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 3: Invidious Adaptive Audio Directo (itag 140 M4A / 251 Opus de YouTube oficial)
// ---------------------------------------------------------------------------
async function resolverInvidiousDirecto(videoId) {
  if (!videoId || videoId.length !== 11) return null;
  const invidiousHosts = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.jing.rocks',
    'https://invidious.f5.si',
    'https://inv.tux.pizza'
  ];

  for (const host of invidiousHosts) {
    try {
      const r = await axios.get(`${host}/api/v1/videos/${videoId}`, {
        signal: getTimeoutSignal(6000),
        timeout: 6000,
        headers: { 'User-Agent': UA }
      });
      const formatos = (r.data?.adaptiveFormats || []).filter((f) => f.type?.startsWith('audio/') && f.url);
      const mejor =
        formatos.find((f) => String(f.itag) === '140') ||
        formatos.find((f) => String(f.itag) === '251') ||
        formatos[0];
      if (mejor && mejor.url) {
        console.log(`[Invidious Oficial Éxito]: Resuelto audio original de YouTube (${videoId}) vía ${host}`);
        return {
          url: mejor.url,
          calidad: '160k',
          nivel: 3,
          proveedor: 'Invidious-Official-Audio'
        };
      }
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// NIVEL 4: SoundCloud Directo SOLO con Verificación Discográfica Estricta
// (PROHIBIDO búsqueda abierta sin verificar artista y duración exacta ±10s)
// ---------------------------------------------------------------------------
async function probarSoundCloudVerificadoDisquera(tituloOriginal = '', artistaOriginal = '', duracionRefSegs = 0) {
  if (!artistaOriginal || !tituloOriginal) return null;
  try {
    let clientId = await obtenerClientIdSoundCloud();
    if (!clientId) clientId = await obtenerClientIdSoundCloud(true);
    if (!clientId) return null;

    const { tituloLimpio, artistaPrincipal } = construirConsultasOriginalYRescate(tituloOriginal, artistaOriginal);
    const qSc = `${artistaPrincipal} ${tituloLimpio}`.trim();

    const r = await axios.get('https://api-v2.soundcloud.com/search/tracks', {
      params: { q: qSc, client_id: clientId, limit: 15 },
      headers: { 'User-Agent': UA },
      signal: getTimeoutSignal(7000),
      timeout: 7000,
      validateStatus: (status) => status === 200
    });

    const coleccion = (r.data?.collection || [])
      .filter((p) => p.policy !== 'SNIP' && p.policy !== 'BLOCK')
      .filter((p) => p.full_duration >= 45000 && p.full_duration <= 720000);

    if (!coleccion.length) return null;

    const artNorm = normalizarTextoSimple(artistaPrincipal);
    const titNorm = normalizarTextoSimple(tituloLimpio);

    // Filtrar EXCLUSIVAMENTE pistas cuya cuenta/metadato oficial coincida con el artista,
    // sin ninguna palabra de la lista negra estricta y dentro de ±10 segundos exactos
    const verificadas = coleccion.filter((p) => {
      const durSegs = Math.round((p.full_duration || 0) / 1000);
      if (duracionRefSegs > 0 && Math.abs(durSegs - duracionRefSegs) > 10) {
        return false;
      }

      const username = p.user?.username || '';
      const pubArtist = p.publisher_metadata?.artist || '';
      const trackTitle = p.title || '';

      if (esResultadoEnListaNegra(trackTitle, `${username} ${pubArtist}`, tituloOriginal)) {
        return false;
      }

      const userNorm = normalizarTextoSimple(username);
      const pubNorm = normalizarTextoSimple(pubArtist);
      const titleNorm = normalizarTextoSimple(trackTitle);

      // El artista oficial DEBE coincidir en publisher_metadata.artist, en la cuenta oficial del usuario, o en título + sello verificado
      const artistaVerificado =
        (pubNorm && pubNorm.includes(artNorm)) ||
        (userNorm && userNorm.includes(artNorm)) ||
        (p.user?.verified === true && titleNorm.includes(artNorm));

      if (!artistaVerificado) return false;

      // El título limpio debe coincidir
      const palabrasTit = titNorm.split(' ').filter((w) => w.length >= 2);
      const coincideTit =
        titleNorm.includes(titNorm) ||
        (palabrasTit.length > 0 && palabrasTit.every((w) => titleNorm.includes(w)));

      return coincideTit;
    });

    if (!verificadas.length) return null;

    // Ordenar por menor diferencia de duración respecto a Spotify
    if (duracionRefSegs > 0) {
      const refMs = duracionRefSegs * 1000;
      verificadas.sort((a, b) => Math.abs(a.full_duration - refMs) - Math.abs(b.full_duration - refMs));
    }

    for (const pista of verificadas) {
      const trans = pista.media?.transcodings || [];
      const progresivo = trans.find((t) => t.format?.protocol === 'progressive');
      if (progresivo) {
        try {
          const streamInfo = await axios.get(progresivo.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(5000),
            timeout: 5000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            console.log(`[Disquera Verificada SC Progressive]: "${pista.title}" - ${pista.publisher_metadata?.artist || pista.user?.username} (${Math.round(pista.full_duration / 1000)}s)`);
            return {
              url: streamInfo.data.url.replace(/^http:\/\//i, 'https://'),
              calidad: '160k',
              nivel: 4,
              proveedor: 'Official-Publisher-Progressive'
            };
          }
        } catch (_) {}
      }

      const hlsMp3 = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mpeg') && !String(t.format?.mime_type || '').includes('mpegurl')
      );
      const hlsAac = trans.find(
        (t) => t.format?.protocol === 'hls' && String(t.format?.mime_type || '').includes('audio/mp4')
      );
      const elegido = hlsMp3 || hlsAac;
      if (elegido) {
        try {
          const streamInfo = await axios.get(elegido.url, {
            params: { client_id: clientId },
            headers: { 'User-Agent': UA },
            signal: getTimeoutSignal(5000),
            timeout: 5000,
            validateStatus: (status) => status === 200
          });
          if (streamInfo.data?.url) {
            const m3u8Url = streamInfo.data.url.replace(/^http:\/\//i, 'https://');
            console.log(`[Disquera Verificada SC HLS]: "${pista.title}" - ${pista.publisher_metadata?.artist || pista.user?.username} (${Math.round(pista.full_duration / 1000)}s)`);
            return {
              url: m3u8Url,
              esHlsSoundCloud: true,
              calidad: '160k',
              nivel: 4,
              proveedor: 'Official-Publisher-HLS'
            };
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// BÚSQUEDA DISCOGRÁFICA ESTRICTA EN YOUTUBE (TOPIC / PROVIDED TO YOUTUBE BY / VEVO)
// ---------------------------------------------------------------------------
async function buscarVideoOriginalEnYouTube(tituloRaw = '', artistaRaw = '', duracionRefSegs = 0) {
  const {
    titulo,
    tituloLimpio,
    artista,
    artistaPrincipal,
    consultasDiscograficas
  } = construirConsultasOriginalYRescate(tituloRaw, artistaRaw);

  // Filtra de inmediato cualquier video que NO cumpla el Filtro de Autor/Canal Obligatorio,
  // la Lista Negra Estricta y la Validación de Duración Exacta (±10 segundos)
  const filtrarCandidatosEstrictos = (videos = []) => {
    const prefiltrados = (videos || []).filter(
      (item) => item && item.videoId && item.seconds >= 45 && item.seconds <= 720
    );
    if (!prefiltrados.length) return [];

    const validos = [];
    for (const v of prefiltrados) {
      const autorNombre = v.author ? (v.author.name || v.author) : '';
      const desc = v.description || '';
      const ev = evaluarCandidatoOriginal({
        tituloCandidato: v.title || '',
        autorCandidato: autorNombre,
        descripcionCandidato: desc,
        duracionSegsCandidato: v.seconds || 0,
        tituloOriginal: titulo,
        artistaOriginal: artista || artistaPrincipal,
        duracionRefSegs,
        toleranciaMaxSegs: 10
      });

      // OBLIGATORIO: Solo pasa si canalValido === true, enListaNegra === false, dentroToleranciaDuracion (±10s) === true y coincideTitulo === true
      if (ev.esAutenticoEstudio) {
        validos.push({ video: v, ev });
      }
    }

    if (validos.length === 0) return [];
    validos.sort((a, b) => a.ev.penalizacion - b.ev.penalizacion);
    return validos.map((x) => x.video);
  };

  // Ejecutar las 3 consultas discográficas obligatorias en orden:
  // 1) "Provided to YouTube by" "${titulo}" "${artista}"
  // 2) "${titulo}" "${artista} - Topic"
  // 3) "${artista}" "${titulo}" "Official Audio"
  for (let idx = 0; idx < consultasDiscograficas.length; idx++) {
    const consulta = consultasDiscograficas[idx];
    try {
      const searchResult = await yts(consulta);
      const videos = searchResult && searchResult.videos ? searchResult.videos : [];
      const oficiales = filtrarCandidatosEstrictos(videos);
      if (oficiales.length > 0) {
        const elegido = oficiales[0];
        console.log(`[Audio Oficial Verificado (Consulta #${idx + 1})]: "${elegido.title}" | Canal: "${elegido.author?.name}" | Duración: ${elegido.seconds}s (Ref: ${duracionRefSegs}s)`);
        return elegido;
      }
    } catch (_) {}
  }

  // Consultar Invidious con las mismas reglas estrictas de autor/canal y duración ±10s
  const invidiousHosts = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://yewtu.be',
    'https://invidious.jing.rocks'
  ];
  for (const host of invidiousHosts) {
    for (const consulta of consultasDiscograficas.slice(0, 2)) {
      try {
        const resp = await axios.get(`${host}/api/v1/search`, {
          params: { q: consulta, type: 'video' },
          timeout: 4500,
          headers: { 'User-Agent': UA }
        });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          const mapeados = resp.data.map((item) => ({
            videoId: item.videoId,
            title: item.title,
            seconds: item.lengthSeconds || 0,
            description: item.description || '',
            author: { name: item.author || '' }
          }));
          const oficiales = filtrarCandidatosEstrictos(mapeados);
          if (oficiales.length > 0) {
            const elegido = oficiales[0];
            console.log(`[Audio Oficial Verificado Invidious]: "${elegido.title}" | Canal: "${elegido.author?.name}" | Duración: ${elegido.seconds}s`);
            return elegido;
          }
        }
      } catch (_) {}
    }
  }

  // Si ningún resultado pasa el filtro estricto de autenticidad, NO devolver ningún cover de relleno
  console.warn(`[Filtro Discográfico Estricto]: Ningún video cumplió los requisitos oficiales (Canal Topic/VEVO/Artista, sin covers y ±10s) para "${artista} - ${titulo}"`);
  return null;
}

// ---------------------------------------------------------------------------
// FUNCIÓN MAESTRA EN CASCADA (PROHIBIDO COVERS DE RELLENO / SOLO ESTUDIO OFICIAL)
// ---------------------------------------------------------------------------
async function resolverAudioConCascada(video, busqueda, formatoDeseado = 'mp3') {
  const formato = normalizarFormato(formatoDeseado);
  const duracionRef = video?.duracionRef || video?.seconds || 0;
  const artistaOriginal = video?.artistaOriginal || (video?.author && video.author.name) || '';
  const tituloOriginal = video?.tituloOriginal || busqueda || video?.title || '';

  const {
    titulo,
    artista,
    consultaOriginal
  } = construirConsultasOriginalYRescate(tituloOriginal, artistaOriginal);

  // Verificar si el video recibido cumple el filtro estricto de canal oficial y lista negra
  let videoOficial = video;
  if (videoOficial && videoOficial.videoId && artista) {
    const autorVid = videoOficial.author ? (videoOficial.author.name || videoOficial.author) : '';
    const ev = evaluarCandidatoOriginal({
      tituloCandidato: videoOficial.title || '',
      autorCandidato: autorVid,
      duracionSegsCandidato: videoOficial.seconds || 0,
      tituloOriginal: titulo,
      artistaOriginal: artista,
      duracionRefSegs: duracionRef,
      toleranciaMaxSegs: 10
    });
    if (!ev.esAutenticoEstudio) {
      console.warn(`[Cascada Oficial]: El video inicial "${videoOficial.title}" (${autorVid}) fue rechazado por el filtro discográfico. Buscando grabación oficial...`);
      videoOficial = await buscarVideoOriginalEnYouTube(titulo, artista, duracionRef);
    }
  } else if (!videoOficial || !videoOficial.videoId) {
    videoOficial = await buscarVideoOriginalEnYouTube(titulo, artista, duracionRef);
  }

  const esYouTubeValido = Boolean(
    videoOficial &&
    videoOficial.videoId &&
    videoOficial.videoId.length === 11 &&
    !videoOficial.videoId.startsWith('itunes_')
  );
  const videoUrl = esYouTubeValido ? `https://www.youtube.com/watch?v=${videoOficial.videoId}` : null;

  console.log(`\n----------------------------------------------------------------------`);
  console.log(`[Cascada Oficial Estudio]: Resolviendo "${consultaOriginal}" (VideoID Oficial: ${videoOficial?.videoId || 'ninguno'}, Canal: "${videoOficial?.author?.name || 'N/A'}", DurRef: ${duracionRef}s)`);

  // 1. NIVEL 1: Extractor nativo @distube/ytdl-core sobre el video OFICIAL verificado (Topic / VEVO / Canal Oficial)
  if (videoUrl) {
    try {
      const resYtdl = await Promise.race([
        resolverNativoYtdl(videoUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 1 YTDL Timeout 8s')), 8000))
      ]);
      if (resYtdl && resYtdl.url) {
        return resYtdl;
      }
    } catch (e1) {
      console.warn(`[Nivel 1 YTDL Oficial]: Pasando a Nivel 2 (${e1.message})`);
    }
  }

  // 2. NIVEL 2: Loader / Savenow sobre el video OFICIAL verificado
  if (videoUrl) {
    try {
      const resLoader = await Promise.race([
        probarLoaderSavenow(videoUrl, formato),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Nivel 2 Loader Timeout 8s')), 8000))
      ]);
      if (resLoader && resLoader.url) {
        return resLoader;
      }
    } catch (e2) {
      console.warn(`[Nivel 2 Loader Oficial]: Pasando a Nivel 3 (${e2.message})`);
    }
  }

  // 3. NIVEL 3: Invidious Adaptive Audio Directo sobre el mismo videoId OFICIAL verificado
  if (esYouTubeValido) {
    try {
      const resInv = await resolverInvidiousDirecto(videoOficial.videoId);
      if (resInv && resInv.url) {
        return resInv;
      }
    } catch (e3) {
      console.warn(`[Nivel 3 Invidious Oficial]: Falló (${e3.message})`);
    }
  }

  // Si ningún resultado pasa este filtro estricto de autenticidad, NO devolver ningún cover de relleno
  console.error(`[Cascada Oficial]: No se encontró el audio oficial de estudio del artista para "${artista} - ${titulo}".`);
  return null;
}

module.exports = {
  resolverAudioConCascada,
  ensamblarHlsSoundCloudABuffer,
  normalizarFormato,
  getTimeoutSignal,
  buscarVideoOriginalEnYouTube,
  construirConsultasOriginalYRescate,
  limpiarTituloParaRescate,
  evaluarCandidatoOriginal,
  esResultadoEnListaNegra,
  esCanalAutorOficialValido
};
