/*
 * Совместимый с Yandex Games SDK слой поверх SDK Одноклассников (FAPI).
 * Игра обращается к window.YaGames как обычно, а реклама и сохранения идут через ОК.
 * Вне Одноклассников (локально) работает в тестовом режиме: награды без рекламы, сохранения в localStorage.
 */
(function () {
  var params = {};
  try { new URLSearchParams(location.search).forEach(function (v, k) { params[k] = v; }); } catch (e) {}
  var inOK = !!(params.api_server && params.apiconnection);

  /* ---------- диспетчер API_callback ---------- */
  var handlers = {};                       // method -> [fn]
  var prevCallback = window.API_callback;
  window.API_callback = function (method, result, data) {
    var list = handlers[method] || [];
    handlers[method] = list.filter(function (fn) { return !fn(result, data); }); // fn вернул true -> снять подписку
    if (typeof prevCallback === 'function') { try { prevCallback(method, result, data); } catch (e) {} }
  };
  function on(method, fn) { (handlers[method] = handlers[method] || []).push(fn); }

  /* ---------- инициализация FAPI ---------- */
  var ready = new Promise(function (resolve) {
    if (!inOK) return resolve(false);
    var tries = 0;
    (function wait() {
      if (window.FAPI && FAPI.init) {
        FAPI.init(params.api_server, params.apiconnection, function () { resolve(true); }, function () { resolve(false); });
      } else if (tries++ < 100) setTimeout(wait, 100);
      else resolve(false);
    })();
  });

  /* ---------- реклама за вознаграждение: loadAd -> showLoadedAd ---------- */
  var rewardReady = false, loading = false;
  function preload() {
    if (!inOK || rewardReady || loading) return;
    loading = true;
    on('loadAd', function (result, data) {
      loading = false;
      rewardReady = result === 'ok';
      if (!rewardReady) setTimeout(preload, 30000);
      return true;
    });
    try { FAPI.UI.loadAd(); } catch (e) { loading = false; }
  }

  function showRewarded(cb) {
    cb = cb || {};
    if (!inOK) { // локальная отладка
      cb.onOpen && cb.onOpen(); cb.onRewarded && cb.onRewarded(); cb.onClose && cb.onClose();
      return;
    }
    if (!rewardReady) { preload(); cb.onError && cb.onError(new Error('no_ads')); return; }
    rewardReady = false;
    cb.onOpen && cb.onOpen();
    var done = false;
    var finish = function (rewarded) {
      if (done) return; done = true;
      if (rewarded) cb.onRewarded && cb.onRewarded();
      cb.onClose && cb.onClose(rewarded);
      setTimeout(preload, 1000);
    };
    on('showLoadedAd', function (result, data) {
      if (result === 'event') return false;                       // служебное событие о формате
      finish(result === 'ok' && (data === 'complete' || data === 'ad_shown'));
      return true;
    });
    setTimeout(function () { finish(false); }, 120000);            // страховка
    try { FAPI.UI.showLoadedAd(); } catch (e) { finish(false); }
  }

  /* ---------- полноэкранная реклама: showAd ---------- */
  var interBusy = false;
  function showInterstitial(cb) {
    cb = cb || {};
    if (!inOK || interBusy) { cb.onClose && cb.onClose(false); return; }
    interBusy = true;
    var opened = false, done = false;
    var finish = function (shown) {
      if (done) return; done = true; interBusy = false;
      if (opened) cb.onClose && cb.onClose(shown); else cb.onError ? cb.onError(new Error('no_ads')) : (cb.onClose && cb.onClose(false));
    };
    on('showAd', function (result, data) {
      if (result === 'event') return false;
      if (result === 'ok' && (data === 'ready' || data === 'ad_prepared')) {
        if (!opened) { opened = true; cb.onOpen && cb.onOpen(); }
        return false;
      }
      finish(result === 'ok' && data === 'ad_shown');
      return true;
    });
    setTimeout(function () { finish(false); }, 90000);
    try { FAPI.UI.showAd(); } catch (e) { finish(false); }
  }

  /* ---------- облачные сохранения: storage.set / storage.get (по частям) ---------- */
  var CHUNK = 1500, PREFIX = 'sv';
  function call(params) {
    return new Promise(function (resolve, reject) {
      try {
        FAPI.Client.call(params, function (status, data, error) { status === 'ok' ? resolve(data) : reject(error); });
      } catch (e) { reject(e); }
    });
  }
  var local = {
    get: function () { try { return JSON.parse(localStorage.getItem('okshim_data') || '{}'); } catch (e) { return {}; } },
    set: function (o) { try { localStorage.setItem('okshim_data', JSON.stringify(o)); } catch (e) {} }
  };
  var cache = null, saving = Promise.resolve();
  async function cloudGet() {
    if (!inOK) return local.get();
    var n = await call({ method: 'storage.get', keys: PREFIX + 'n' });
    var count = +((n && n.data && n.data[PREFIX + 'n']) || 0);
    if (!count) return {};
    var keys = []; for (var i = 0; i < count; i++) keys.push(PREFIX + i);
    var r = await call({ method: 'storage.get', keys: keys.join(',') });
    var str = keys.map(function (k) { return (r && r.data && r.data[k]) || ''; }).join('');
    try { return JSON.parse(str); } catch (e) { return {}; }
  }
  async function cloudSet(obj) {
    if (!inOK) { local.set(obj); return; }
    var str = JSON.stringify(obj), parts = [];
    for (var i = 0; i < str.length; i += CHUNK) parts.push(str.slice(i, i + CHUNK));
    for (var j = 0; j < parts.length; j++) await call({ method: 'storage.set', key: PREFIX + j, value: parts[j] });
    await call({ method: 'storage.set', key: PREFIX + 'n', value: String(parts.length) });
  }

  var player = {
    getMode: function () { return 'full'; },
    isAuthorized: function () { return true; },
    getUniqueID: function () { return params.logged_user_id || 'local'; },
    getName: function () { return params.user_name || ''; },
    getData: async function (keys) {
      try { cache = await cloudGet(); } catch (e) { cache = cache || {}; }
      if (!keys) return cache;
      var out = {}; keys.forEach(function (k) { if (k in cache) out[k] = cache[k]; });
      return out;
    },
    setData: function (obj) {
      cache = Object.assign({}, cache || {}, obj);
      var snapshot = cache;
      saving = saving.then(function () { return cloudSet(snapshot); }).catch(function () {});
      return saving;
    }
  };

  /* ---------- объект, повторяющий интерфейс ysdk ---------- */
  var sdk = {
    environment: { i18n: { lang: 'ru', tld: 'ru' } },
    features: {
      LoadingAPI: { ready: function () {} },
      GameplayAPI: { start: function () {}, stop: function () {} }
    },
    adv: {
      showFullscreenAdv: function (o) { showInterstitial((o && o.callbacks) || {}); },
      showRewardedVideo: function (o) { showRewarded((o && o.callbacks) || {}); }
    },
    getPlayer: function () { return Promise.resolve(player); },
    auth: { openAuthDialog: function () { return Promise.resolve(); } },
    on: function () {},
    // встроенного рейтинга в ОК нет — игра покажет «рейтинг недоступен»
    leaderboards: {
      setScore: function () { return Promise.resolve(); },
      getEntries: function () { return Promise.reject(new Error('not supported on OK')); }
    },
    getLeaderboards: function () { return Promise.reject(new Error('not supported on OK')); }
  };

  window.YaGames = {
    init: function () {
      return ready.then(function (ok) {
        inOK = ok;
        if (ok) preload();
        return sdk;
      });
    }
  };
})();
