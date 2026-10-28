/**
 * Middleware de Caché en Memoria para URLs de Streaming y Descargas
 * Almacena resoluciones exitosas por `videoId` y calidad/formato con TTL seguro (15 minutos).
 * Protege contra URLs dinámicas expiradas y preserva CORS y metadatos íntegros.
 */

class StreamMemoryCache {
  constructor(maxEntries = 500, ttlMs = 15 * 60 * 1000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs; // 15 Minutos (respetando tiempo de vida de tokens de proveedores)
  }

  _normalizarClave(key) {
    return String(key || '').trim().toLowerCase();
  }

  obtener(key) {
    const k = this._normalizarClave(key);
    if (!k) return null;

    const entrada = this.cache.get(k);
    if (!entrada) return null;

    const haExpirado = Date.now() - entrada.timestamp > this.ttlMs;
    if (haExpirado) {
      this.cache.delete(k);
      return null;
    }

    // Política LRU: refrescar clave al final para marcarla como usada recientemente
    this.cache.delete(k);
    this.cache.set(k, entrada);

    return entrada.data;
  }

  guardar(key, data) {
    const k = this._normalizarClave(key);
    if (!k || !data) return;

    if (this.cache.size >= this.maxEntries) {
      const primerClave = this.cache.keys().next().value;
      if (primerClave) this.cache.delete(primerClave);
    }

    this.cache.set(k, {
      data: { ...data }, // Clon exacto sin mutaciones
      timestamp: Date.now()
    });
  }

  limpiarExpirados() {
    const ahora = Date.now();
    for (const [k, entrada] of this.cache.entries()) {
      if (ahora - entrada.timestamp > this.ttlMs) {
        this.cache.delete(k);
      }
    }
  }

  obtenerEstadisticas() {
    return {
      entradasActivas: this.cache.size,
      maxEntradas: this.maxEntries,
      ttlMinutos: this.ttlMs / (1000 * 60)
    };
  }
}

// Instancia singleton para el proceso del servidor
const streamCache = new StreamMemoryCache();

// Limpieza periódica de expirados cada 10 minutos
setInterval(() => {
  streamCache.limpiarExpirados();
}, 10 * 60 * 1000).unref();

/**
 * Middleware Express no invasivo
 * Intercepta peticiones a la ruta de resolución (/api/obtener-enlace)
 */
function streamCacheMiddleware(req, res, next) {
  // Asegurar siempre cabeceras CORS universales
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type, X-Titulo-Audio, X-Cache-Status');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  const videoId = (req.query.videoId || '').trim();
  const busqueda = (req.query.q || '').trim();
  // Discriminar rigurosamente por formato y calidad (ej. mp3, mp3_320, m4a, 720, etc.)
  const formato = (req.query.formato || req.query.calidad || req.query.format || 'mp3').trim().toLowerCase();
  const forzarFresco = req.query.fresco === 'true' || req.query.nocache === 'true' || req.headers['cache-control'] === 'no-cache';

  // Clave canónica preferente: videoId_formato o busqueda_formato
  const claveCache = videoId ? `${videoId}_${formato}` : (busqueda ? `${busqueda}_${formato}` : null);

  if (!claveCache || forzarFresco) {
    return next();
  }

  // 1. Acierto en caché (Cache HIT) -> Respuesta instantánea (<1ms) con payload íntegro
  const cacheHit = streamCache.obtener(claveCache);
  if (cacheHit && cacheHit.downloadUrl) {
    console.log(`[StreamCache HIT]: Entregando enlace en caché para "${claveCache}"`);
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json({
      titulo: cacheHit.titulo,
      artista: cacheHit.artista,
      duracion: cacheHit.duracion,
      downloadUrl: cacheHit.downloadUrl
    });
  }

  // 2. Fallo de caché (Cache MISS) -> Interceptar res.json de forma no invasiva
  res.setHeader('X-Cache-Status', 'MISS');
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    try {
      if (res.statusCode === 200 && body && body.downloadUrl && !body.error) {
        streamCache.guardar(claveCache, body);
        console.log(`[StreamCache GUARDADO]: Clave "${claveCache}" almacenada en caché.`);
      }
    } catch (e) {
      console.warn('[StreamCache Error al guardar]:', e.message);
    }
    return originalJson(body);
  };

  next();
}

module.exports = {
  streamCache,
  streamCacheMiddleware
};
