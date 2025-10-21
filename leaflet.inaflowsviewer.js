// leaflet.inaflowsviewer.js
// Leaflet control to animate BMKG INAFLOWS Sea Current tiles (Rainviewer-style).
// - Auto-detect latest modelrun from /api21/modelrun (ISO → YYYYMMDDHHMM)
// - Builds a rolling time series (default: 8 frames × 3 hours = 24h)
// - Shows magnitude (mpl_req) and optional arrows (arr_req)
//
// Requires Leaflet. Optional: pair with your CSS (e.g., leaflet.inaflowsviewer.css)

(function (factory) {
  if (typeof define === 'function' && define.amd) {
    define(['leaflet'], factory);
  } else if (typeof module !== 'undefined') {
    module.exports = factory(require('leaflet'));
  } else {
    factory(L);
  }
}(function (L) {
  "use strict";

  // ---------- small utils ----------
  function pad(n){ return String(n).padStart(2,'0'); }
  function fmtKey(d){
    // input: Date | 'YYYYMMDDHHMM'
    if (typeof d === 'string') return d;
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  }
  function parseLabel(key){
    // 'YYYYMMDDHHMM' → "Tue, 21 Oct 2025 21:00 UTC"
    if (!(typeof key === 'string' && key.length >= 12)) return '';
    const Y=+key.slice(0,4), M=+key.slice(4,6), D=+key.slice(6,8), h=+key.slice(8,10), m=+key.slice(10,12);
    const dd = new Date(Date.UTC(Y, M-1, D, h, m, 0));
    return dd.toUTCString().split(' ').slice(0,5).join(' ')+' UTC';
  }

  // ============== Control ==============
  L.Control.inaflowsviewer = L.Control.extend({
    options: {
      position: 'bottomleft',

      // UI texts
      nextButtonText: '>',
      playStopButtonText: 'Start/Stop',
      prevButtonText: '<',
      positionSliderLabelText: 'Time:',
      opacitySliderLabelText: 'Opacity:',
      animationInterval: 500,
      opacity: 0.6,

      // BMKG Sea Current (INAFLOWS) config
      baseUrl: 'https://peta-maritim.bmkg.go.id/api21',
      model: 'inaflows',
      tileId: 'c',      // magnitude id
      level: 0,         // 0,10,25,50,100,250 meters

      // Auto modelrun
      autoModelrun: true,
      modelrun: 'auto',
      modelrunEndpoint: 'https://peta-maritim.bmkg.go.id/api21/modelrun',

      // Time series
      times: [],        // Array<Date|string 'YYYYMMDDHHMM'>; empty => auto build
      stepHours: 3,
      frames: 8,

      // Direction arrows
      showArrows: true,
      arrowsOpacity: 0.9,

      // zIndex
      zIndex: 400,

      // CSS class prefix (use 'leaflet-control-inaflowsviewer' by default)
      classPrefix: 'leaflet-control-inaflowsviewer'
    },

    /* ================= lifecycle ================ */
    onAdd: function (map) {
      this._map = map;

      this.timestamps = [];
      this.layersMag = {}; // timeKey → L.TileLayer (magnitude)
      this.layersArr = {}; // timeKey → L.TileLayer (arrows)
      this.animationPosition = 0;
      this.animationTimer = null;

      // Root container + open button
      const rootCls = `${this.options.classPrefix} leaflet-bar leaflet-control`;
      this.container = L.DomUtil.create('div', rootCls);

      const btnCls = `${this.options.classPrefix}-button leaflet-bar-part`;
      this.link = L.DomUtil.create('a', btnCls, this.container);
      this.link.href = '#';
      L.DomEvent.on(this.link, 'click', this._toggle, this);

      return this.container;
    },

    onRemove: function () {
      this.unload();
    },

    /* ================= open/close ================ */
    _toggle: function (e) {
      L.DomEvent.stop(e);
      if (L.DomUtil.hasClass(this.container, `${this.options.classPrefix}-active`)) {
        this.unload();
      } else {
        this.load();
      }
    },

    unload: function () {
      this.stop();

      // remove UI
      if (this.controlContainer) { L.DomUtil.remove(this.controlContainer); this.controlContainer = null; }
      if (this.closeButton) { L.DomUtil.remove(this.closeButton); this.closeButton = null; }
      L.DomUtil.removeClass(this.container, `${this.options.classPrefix}-active`);

      // remove layers
      const map = this._map;
      Object.values(this.layersMag).forEach(l => map && map.hasLayer(l) && map.removeLayer(l));
      Object.values(this.layersArr).forEach(l => map && map.hasLayer(l) && map.removeLayer(l));
      this.layersMag = {};
      this.layersArr = {};
      this.timestamps = [];
      this.animationPosition = 0;
    },

    /* ================= main load ================ */
    load: async function () {
      // 1) resolve modelrun
      if (this.options.autoModelrun && (!this.options.modelrun || this.options.modelrun === 'auto')) {
        this.options.modelrun = await this._getLatestModelrun();
      }

      // 2) timestamps
      if (!this.options.times || !this.options.times.length) {
        this.timestamps = this._buildTimes({
          frames: this.options.frames,
          stepHours: this.options.stepHours
        }).map(fmtKey);
      } else {
        this.timestamps = this.options.times.map(fmtKey);
      }
      this.animationPosition = Math.max(0, this.timestamps.length - 1);

      // 3) build UI
      L.DomUtil.addClass(this.container, `${this.options.classPrefix}-active`);
      this._buildUI();

      // 4) show first & preload next
      this.showFrame(this.animationPosition);
      this._preload(this.animationPosition + 1);
    },

    /* ================== UI ================== */
    _buildUI: function(){
      const p = this.options.classPrefix;

      this.controlContainer = L.DomUtil.create('div', `${p}-container`, this.container);

      // prevent map interactions
      const stop = (e)=>{ e.preventDefault(); e.stopPropagation(); };
      ['mousedown','wheel','dblclick','pointerdown','touchstart'].forEach(ev=>{
        this.controlContainer.addEventListener(ev, stop, {passive:false});
      });

      // buttons
      this.prevButton = this._mkBtn(`${p}-prev leaflet-bar-part btn`, this.options.prevButtonText, this.prev);
      this.startstopButton = this._mkBtn(`${p}-startstop leaflet-bar-part btn`, this.options.playStopButtonText, this.startstop);
      this.nextButton = this._mkBtn(`${p}-next leaflet-bar-part btn`, this.options.nextButtonText, this.next);

      // append buttons
      this.controlContainer.appendChild(this.prevButton);
      this.controlContainer.appendChild(this.startstopButton);
      this.controlContainer.appendChild(this.nextButton);

      // labels & sliders
      this.positionSliderLabel = this._mkLabel(`${p}-label`, 'cv-pos-label', this.options.positionSliderLabelText);
      this.controlContainer.appendChild(this.positionSliderLabel);

      this.positionSlider = this._mkRange(`${p}-positionslider`, 0, this.timestamps.length-1, this.animationPosition, this.setPosition);
      this.positionSlider.id = 'cv-positionslider';
      this.controlContainer.appendChild(this.positionSlider);

      this.opacitySliderLabel = this._mkLabel(`${p}-label`, 'cv-opc-label', this.options.opacitySliderLabelText);
      this.controlContainer.appendChild(this.opacitySliderLabel);

      this.opacitySlider = this._mkRange(`${p}-opacityslider`, 0, 100, Math.round(this.options.opacity*100), this.setOpacity);
      this.opacitySlider.id = 'cv-opacityslider';
      this.controlContainer.appendChild(this.opacitySlider);

      // timestamp text
      const timeEl = L.DomUtil.create('div', `${p}-timestamp`, this.controlContainer);
      timeEl.id = 'cv-timestamp';

      // close button
      this.closeButton = L.DomUtil.create('div', `${p}-close`, this.container);
      L.DomEvent.on(this.closeButton, 'click', this.unload, this);
    },

    _mkBtn: function (cls, text, handler) {
      const el = L.DomUtil.create('input', cls);
      el.type = 'button';
      el.value = text;
      L.DomEvent.on(el, 'click', handler, this);
      L.DomEvent.disableClickPropagation(el);
      return el;
    },

    _mkLabel: function (cls, forId, text){
      const el = L.DomUtil.create('label', cls);
      el.htmlFor = forId;
      el.textContent = text;
      return el;
    },

    _mkRange: function (cls, min, max, value, onInput){
      const el = L.DomUtil.create('input', cls);
      el.type = 'range';
      el.min = String(min);
      el.max = String(max);
      el.value = String(value);
      L.DomEvent.on(el, 'input', onInput, this);
      L.DomEvent.disableClickPropagation(el);
      return el;
    },

    /* ================= Tiles ================= */
    _urlMag: function (timeKey) {
      const o = this.options;
      return `${o.baseUrl}/mpl_req/${o.model}/${o.tileId}/${o.level}/${o.modelrun}/${timeKey}/{z}/{x}/{y}.png?ci=1&overlays=,contourf&conc=snow`;
    },

    _urlArr: function (timeKey) {
      const o = this.options;
      return `${o.baseUrl}/arr_req/${o.model}/${o.tileId}/${o.level}/${o.modelrun}/${timeKey}/{z}/{x}/{y}.png?color=white`;
    },

    _ensureLayers: function (timeKey) {
      const map = this._map;

      if (!this.layersMag[timeKey]) {
        this.layersMag[timeKey] = L.tileLayer(this._urlMag(timeKey), {
          tms: true,
          opacity: 0.001,
          transparent: true,
          zIndex: this.options.zIndex
        });
      }
      if (!map.hasLayer(this.layersMag[timeKey])) map.addLayer(this.layersMag[timeKey]);

      if (this.options.showArrows) {
        if (!this.layersArr[timeKey]) {
          this.layersArr[timeKey] = L.tileLayer(this._urlArr(timeKey), {
            tms: true,
            opacity: this.options.arrowsOpacity,
            transparent: true,
            zIndex: this.options.zIndex + 1
          });
        }
        if (!map.hasLayer(this.layersArr[timeKey])) map.addLayer(this.layersArr[timeKey]);
      }
    },

    /* ================ Animation API ================ */
    changePosition: function (pos, preloadOnly) {
      // wrap
      const len = this.timestamps.length;
      if (!len) return;
      while (pos >= len) pos -= len;
      while (pos < 0) pos += len;

      const prevKey = this.timestamps[this.animationPosition];
      const nextKey = this.timestamps[pos];

      // ensure next layers exist
      this._ensureLayers(nextKey);
      if (preloadOnly) return;

      // update position
      this.animationPosition = pos;
      if (this.positionSlider) this.positionSlider.value = String(pos);

      // fade magnitude
      if (prevKey && this.layersMag[prevKey]) this.layersMag[prevKey].setOpacity(0);
      if (this.layersMag[nextKey]) this.layersMag[nextKey].setOpacity(this.options.opacity);

      // timestamp label
      const el = document.getElementById('cv-timestamp');
      if (el) el.innerHTML = parseLabel(nextKey);
    },

    showFrame: function (nextPos) {
      const dir = nextPos - this.animationPosition > 0 ? 1 : -1;
      this.changePosition(nextPos);
      this._preload(nextPos + dir);
    },

    _preload: function (pos) {
      this.changePosition(pos, true);
    },

    /* ================ UI handlers ================ */
    setOpacity: function (e) {
      const val = Number((e.target || e.srcElement).value) / 100;
      this.options.opacity = val;
      const key = this.timestamps[this.animationPosition];
      if (key && this.layersMag[key]) this.layersMag[key].setOpacity(val);
    },

    setPosition: function (e) {
      const val = Number((e.target || e.srcElement).value);
      this.showFrame(val);
    },

    stop: function () {
      if (this.animationTimer) {
        clearTimeout(this.animationTimer);
        this.animationTimer = null;
        return true;
      }
      return false;
    },

    play: function () {
      this.showFrame(this.animationPosition + 1);
      this.animationTimer = setTimeout(function(){ this.play(); }.bind(this), this.options.animationInterval);
    },

    playStop: function () {
      if (!this.stop()) this.play();
    },

    prev: function (e) {
      L.DomEvent.stop(e);
      this.stop();
      this.showFrame(this.animationPosition - 1);
    },

    startstop: function (e) {
      L.DomEvent.stop(e);
      this.playStop();
    },

    next: function (e) {
      L.DomEvent.stop(e);
      this.stop();
      this.showFrame(this.animationPosition + 1);
    },

    /* ================ internal helpers ================ */
    _getLatestModelrun: async function () {
      const endpoint = this.options.modelrunEndpoint || 'https://peta-maritim.bmkg.go.id/api21/modelrun';
      const model = this.options.model || 'inaflows';
      try {
        const res = await fetch(endpoint);
        const json = await res.json();
        const runsISO = json && json[model];
        if (!runsISO || !runsISO.length) throw new Error('No modelrun list');
        // sort asc, pick last
        const latestISO = runsISO.slice().sort().pop(); // e.g. "2025-10-21T00:00:00Z"
        const d = new Date(latestISO);
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
      } catch (err) {
        console.warn('[inaflowsviewer] modelrun fetch failed, fallback to YYYYMMDD0000:', err);
        const now = new Date();
        return `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}0000`;
      }
    },

    _snap3hUTC: function (date = new Date()) {
      const h = date.getUTCHours();
      const slot = h<=3?3:h<=6?6:h<=9?9:h<=12?12:h<=15?15:h<=18?18:h<=21?21:24;
      const out = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), slot%24, 0, 0));
      if (slot === 24) out.setUTCDate(out.getUTCDate()+1);
      return out;
    },

    _buildTimes: function ({ frames = 8, stepHours = 3 } = {}) {
      const end = this._snap3hUTC(new Date());
      const arr = [];
      for (let i = frames - 1; i >= 0; i--) {
        arr.push(new Date(end.getTime() - i * stepHours * 3600 * 1000));
      }
      return arr;
    }
  });

  // factory
  L.control.inaflowsviewer = function (opts) {
    return new L.Control.inaflowsviewer(opts);
  };
}));

