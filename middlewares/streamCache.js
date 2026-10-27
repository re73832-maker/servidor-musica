/**
 * Middleware de Caché en Memoria para URLs de Streaming y Descargas
 * Almacena resoluciones exitosas por `videoId` con un TTL de 4 horas.
 * Desacoplado, no invasivo y protegido contra fugas de memoria con política LRU.
 */

class StreamMemoryCache {
  constructor(maxEntries = 500, ttlMs = 4 * 60 * 60 * 1000) {
    this.cache = new Map();
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs; // 4 Horas
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

    // Si excede el límite máximo de memoria, retirar el elemento más antiguo
    if (this.cache.size >= this.maxEntries) {
      const primerClave = this.cache.keys().next().value;
      if (primerClave) this.cache.delete(primerClave);
    }

    this.cache.set(k, {
      data,
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
      ttlHoras: this.ttlMs / (1000 * 60 * 60)
    };
  }
}

// Instancia singleton para el proceso del servidor
const streamCache = new StreamMemoryCache();

// Limpieza periódica de expirados cada 30 minutos sin bloquear el event loop
setInterval(() => {
  streamCache.limpiarExpirados();
}, 30 * 60 * 1000).unref();

/**
 * Middleware Express no invasivo
 * Intercepta peticiones a la ruta de resolución (/api/obtener-enlace)
 */
function streamCacheMiddleware(req, res, next) {
  const videoId = (req.query.videoId || '').trim();
  const busqueda = (req.query.q || '').trim();
  const formato = (req.query.formato || 'mp3').trim().toLowerCase();

  // Clave canónica preferente: videoId_formato o busqueda_formato
  const claveCache = videoId ? `${videoId}_${formato}` : (busqueda ? `${busqueda}_${formato}` : null);

  if (!claveCache) {
    return next();
  }

  // 1. Acierto en caché (Cache HIT) -> Respuesta instantánea (<1ms)
  const cacheHit = streamCache.obtener(claveCache);
  if (cacheHit) {
    console.log(`[StreamCache HIT]: Entregando enlace en caché para "${claveCache}"`);
    res.setHeader('X-Cache-Status', 'HIT');
    return res.json(cacheHit);
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
