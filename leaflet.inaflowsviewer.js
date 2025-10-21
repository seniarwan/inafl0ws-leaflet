// leaflet.inaflowsviewer.js
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

  // ---------- helpers ----------
  function pad(n){ return String(n).padStart(2,'0'); }
  function fmtKey(d){
    // input: Date | 'YYYYMMDDHHMM'
    if (typeof d === 'string') return d;
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  }
  function parseLabel(d){
    // pretty UTC label from 'YYYYMMDDHHMM' or Date
    if (d instanceof Date) return d.toUTCString().split(' ').slice(0,5).join(' ')+' UTC';
    const Y=d.slice(0,4), M=d.slice(4,6), D=d.slice(6,8), h=d.slice(8,10), m=d.slice(10,12);
    const dd = new Date(Date.UTC(+Y, +M-1, +D, +h, +m, 0));
    return dd.toUTCString().split(' ').slice(0,5).join(' ')+' UTC';
  }

  // ---------- control ----------
  L.Control.inaflowsviewer = L.Control.extend({
    options: {
      position: 'bottomleft',

      // UI texts (mirip Rainviewer)
      nextButtonText: '>',
      playStopButtonText: 'Start/Stop',
      prevButtonText: '<',
      positionSliderLabelText: 'Time:',
      opacitySliderLabelText: 'Opacity:',
      animationInterval: 500,
      opacity: 0.5,

      // Konfigurasi BMKG Sea Current (INAFLOWS)
      baseUrl: 'https://peta-maritim.bmkg.go.id/api21',
      model: 'inaflows',
      tileId: 'c',            // ID magnitude arus
      level: 0,               // 0,10,25,50,100,250 (m)

      // Modelrun otomatis
      autoModelrun: true,
      modelrun: 'auto',
      modelrunEndpoint: 'https://peta-maritim.bmkg.go.id/api21/modelrun',
      // Selector untuk ambil run terbaru dari JSON endpoint
      modelrunSelector: function (json, model) {
        // Ambil array ISO time misal ["2025-10-21T00:00:00Z", "2025-10-20T12:00:00Z"]
        const runs = json && json[model];
        if (!runs || !runs.length) return null;
        // Urutkan dan ambil yang paling baru
        const latestISO = runs.sort().pop(); // "2025-10-21T00:00:00Z"
        // Ubah ke format yang dipakai tile: "YYYYMMDDHHMM"
        const d = new Date(latestISO);
        const pad = n => String(n).padStart(2,'0');
        return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
      },

      // Waktu/animasi
      times: [],              // Date[] | string[] 'YYYYMMDDHHMM' (jika kosong, generate 8 frame 3-jam terakhir)
      stepHours: 3,
      frames: 8,

      // Arah arus (optional)
      showArrows: true,
      arrowsOpacity: 0.9,

      // Z-index
      zIndex: 400
    },

    onAdd: function (map) {
      this._map = map;
      this._boundStop = this.stop.bind(this);

      this.timestamps = [];
      this.layersMag = {};  // { timeKey: L.TileLayer }
      this.layersArr = {};  // { timeKey: L.TileLayer }
      this.animationPosition = 0;
      this.animationTimer = false;

      // Kontainer + button "open"
      this.container = L.DomUtil.create('div', 'leaflet-control-inaflowsviewer leaflet-bar leaflet-control');
      this.link = L.DomUtil.create('a', 'leaflet-control-inaflowsviewer-button leaflet-bar-part', this.container);
      this.link.href = '#';

      // Buka panel dan mulai load
      L.DomEvent.on(this.link, 'click', this._open, this);

      return this.container;
    },

    onRemove: function () {
      this.unload();
    },

    // ---------- UI open/close ----------
    _open: function (e) {
      L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
      if (L.DomUtil.hasClass(this.container, 'leaflet-control-inaflowsviewer-active')) {
        this.unload();
      } else {
        this.load();
      }
    },

    unload: function() {
      this.stop();
      // remove UI
      if (this.controlContainer) { L.DomUtil.remove(this.controlContainer); this.controlContainer = null; }
      if (this.closeButton) { L.DomUtil.remove(this.closeButton); this.closeButton = null; }
      L.DomUtil.removeClass(this.container, 'leaflet-control-inaflowsviewer-active');
      // remove layers
      const map = this._map;
      Object.values(this.layersMag).forEach(l => map && map.hasLayer(l) && map.removeLayer(l));
      Object.values(this.layersArr).forEach(l => map && map.hasLayer(l) && map.removeLayer(l));
      this.layersMag = {};
      this.layersArr = {};
      this.timestamps = [];
      this.animationPosition = 0;
    },

    // ---------- main load ----------
    load: async function () {
      // 1) resolve modelrun otomatis
      if (this.options.autoModelrun && (!this.options.modelrun || this.options.modelrun === 'auto')) {
        try {
          const r = await fetch(this.options.modelrunEndpoint);
          const json = await r.json();
          const latest = this.options.modelrunSelector(json, this.options.model);
          if (latest) this.options.modelrun = latest;
          if (!this.options.modelrun) throw new Error('No modelrun resolved');
        } catch (err) {
          console.warn('[inaflowsviewer] Gagal ambil modelrun, fallback YYYYMMDD0000 UTC:', err);
          const now = new Date();
          const p = n=>String(n).padStart(2,'0');
          this.options.modelrun = `${now.getUTCFullYear()}${p(now.getUTCMonth()+1)}${p(now.getUTCDate())}0000`;
        }
      }

      // 2) build timestamps
      if (this.options.times && this.options.times.length) {
        this.timestamps = this.options.times.map(fmtKey);
      } else {
        const end = this._snap3hUTC(new Date());
        const arr = [];
        for (let i=this.options.frames-1; i>=0; i--){
          const d = new Date(end.getTime() - i*this.options.stepHours*3600*1000);
          arr.push(fmtKey(d));
        }
        this.timestamps = arr;
      }
      this.animationPosition = this.timestamps.length - 1;

      // 3) build UI
      L.DomUtil.addClass(this.container, 'leaflet-control-inaflowsviewer-active');
      this._buildUI();

      // 4) show first and preload next
      this.showFrame(this.animationPosition);
      this._preload(this.animationPosition + 1);
    },

    // ---------- UI builder ----------
    _buildUI: function(){
      const t = this;

      // container
      this.controlContainer = L.DomUtil.create('div', 'leaflet-control-inaflowsviewer-container', this.container);
      // cegah drag/zoom saat interaksi control
      const stop = (e)=>{ e.preventDefault(); e.stopPropagation(); };
      this.controlContainer.addEventListener('mousedown', stop);
      this.controlContainer.addEventListener('wheel', stop);
      this.controlContainer.addEventListener('dblclick', stop);

      // prev
      this.prevButton = L.DomUtil.create('input', 'leaflet-control-inaflowsviewer-prev leaflet-bar-part btn', this.controlContainer);
      this.prevButton.type = "button";
      this.prevButton.value = this.options.prevButtonText;
      L.DomEvent.on(this.prevButton, 'click', t.prev, this);
      L.DomEvent.disableClickPropagation(this.prevButton);

      // play/stop
      this.startstopButton = L.DomUtil.create('input', 'leaflet-control-inaflowsviewer-startstop leaflet-bar-part btn', this.controlContainer);
      this.startstopButton.type = "button";
      this.startstopButton.value = this.options.playStopButtonText;
      L.DomEvent.on(this.startstopButton, 'click', t.startstop, this);
      L.DomEvent.disableClickPropagation(this.startstopButton);

      // next
      this.nextButton = L.DomUtil.create('input', 'leaflet-control-inaflowsviewer-next leaflet-bar-part btn', this.controlContainer);
      this.nextButton.type = "button";
      this.nextButton.value = this.options.nextButtonText;
      L.DomEvent.on(this.nextButton, 'click', t.next, this);
      L.DomEvent.disableClickPropagation(this.nextButton);

      // label posisi (Time)
      this.positionSliderLabel = L.DomUtil.create('label', 'leaflet-control-inaflowsviewer-label leaflet-bar-part', this.controlContainer);
      this.positionSliderLabel.for = "inaflowsviewer-positionslider";
      this.positionSliderLabel.textContent = this.options.positionSliderLabelText;

      // slider posisi
      this.positionSlider = L.DomUtil.create('input', 'leaflet-control-inaflowsviewer-positionslider leaflet-bar-part', this.controlContainer);
      this.positionSlider.type = "range";
      this.positionSlider.id = "inaflowsviewer-positionslider";
      this.positionSlider.min = 0;
      this.positionSlider.max = this.timestamps.length - 1;
      this.positionSlider.value = this.animationPosition;
      L.DomEvent.on(this.positionSlider, 'input', t.setPosition, this);
      L.DomEvent.disableClickPropagation(this.positionSlider);

      // label opacity
      this.opacitySliderLabel = L.DomUtil.create('label', 'leaflet-control-inaflowsviewer-label leaflet-bar-part', this.controlContainer);
      this.opacitySliderLabel.for = "inaflowsviewer-opacityslider";
      this.opacitySliderLabel.textContent = this.options.opacitySliderLabelText;

      // slider opacity
      this.opacitySlider = L.DomUtil.create('input', 'leaflet-control-inaflowsviewer-opacityslider leaflet-bar-part', this.controlContainer);
      this.opacitySlider.type = "range";
      this.opacitySlider.id = "inaflowsviewer-opacityslider";
      this.opacitySlider.min = 0;
      this.opacitySlider.max = 100;
      this.opacitySlider.value = this.options.opacity * 100;
      L.DomEvent.on(this.opacitySlider, 'input', t.setOpacity, this);
      L.DomEvent.disableClickPropagation(this.opacitySlider);

      // timestamp text
      const html = '<div id="inaflowsviewer-timestamp" class="leaflet-control-inaflowsviewer-timestamp"></div>';
      this.controlContainer.insertAdjacentHTML('beforeend', html);

      // tombol close
      this.closeButton = L.DomUtil.create('div', 'leaflet-control-inaflowsviewer-close', this.container);
      L.DomEvent.on(this.closeButton, 'click', t.unload, this);
    },

    // ---------- tiles ----------
    _urlMag: function(timeKey){
      const o = this.options;
      return `${o.baseUrl}/mpl_req/${o.model}/${o.tileId}/${o.level}/${o.modelrun}/${timeKey}/{z}/{x}/{y}.png?ci=1&overlays=,contourf&conc=snow`;
    },
    _urlArr: function(timeKey){
      const o = this.options;
      return `${o.baseUrl}/arr_req/${o.model}/${o.tileId}/${o.level}/${o.modelrun}/${timeKey}/{z}/{x}/{y}.png?color=white`;
    },
    _addLayerIfNeeded: function(timeKey){
      const map = this._map;
      // magnitude
      if (!this.layersMag[timeKey]) {
        this.layersMag[timeKey] = L.tileLayer(this._urlMag(timeKey), {
          tms:true, opacity: 0.001, transparent:true, zIndex: this.options.zIndex
        });
      }
      if (!map.hasLayer(this.layersMag[timeKey])) map.addLayer(this.layersMag[timeKey]);

      // arrows (optional)
      if (this.options.showArrows) {
        if (!this.layersArr[timeKey]) {
          this.layersArr[timeKey] = L.tileLayer(this._urlArr(timeKey), {
            tms:true, opacity: this.options.arrowsOpacity, transparent:true, zIndex: this.options.zIndex+1
          });
        }
        if (!map.hasLayer(this.layersArr[timeKey])) map.addLayer(this.layersArr[timeKey]);
      }
    },

    // ---------- animasi ----------
    changePosition: function(position, preloadOnly){
      // wrap
      while (position >= this.timestamps.length) position -= this.timestamps.length;
      while (position < 0) position += this.timestamps.length;

      const prevKey = this.timestamps[this.animationPosition];
      const nextKey = this.timestamps[position];

      // pastikan layer berikutnya ada (preload)
      this._addLayerIfNeeded(nextKey);
      if (preloadOnly) return;

      // set posisi animasi
      this.animationPosition = position;
      if (this.positionSlider) this.positionSlider.value = position;

      // transisi opacity magnitude (fade in/out)
      if (prevKey && this.layersMag[prevKey]) this.layersMag[prevKey].setOpacity(0);
      if (this.layersMag[nextKey]) this.layersMag[nextKey].setOpacity(this.options.opacity);

      // arrows tetap (opacity tetap di layersArr[nextKey])

      // update label waktu
      const el = document.getElementById('inaflowsviewer-timestamp');
      if (el) el.innerHTML = parseLabel(nextKey);
    },

    showFrame: function(nextPosition){
      const dir = nextPosition - this.animationPosition > 0 ? 1 : -1;
      this.changePosition(nextPosition);
      this._preload(nextPosition + dir);
    },

    _preload: function(pos){
      this.changePosition(pos, true);
    },

    // ---------- handlers UI ----------
    setOpacity: function(e){
      const val = Number(e.srcElement.value)/100;
      this.options.opacity = val;
      const key = this.timestamps[this.animationPosition];
      if (key && this.layersMag[key]) this.layersMag[key].setOpacity(val);
    },

    setPosition: function(e){
      this.showFrame(Number(e.srcElement.value));
    },

    stop: function(){
      if (this.animationTimer) {
        clearTimeout(this.animationTimer);
        this.animationTimer = false;
        return true;
      }
      return false;
    },

    play: function(){
      this.showFrame(this.animationPosition + 1);
      this.animationTimer = setTimeout(function(){ this.play(); }.bind(this), this.options.animationInterval);
    },

    playStop: function(){
      if (!this.stop()) this.play();
    },

    prev: function(e){
      L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
      this.stop(); this.showFrame(this.animationPosition - 1);
    },

    startstop: function(e){
      L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
      this.playStop();
    },

    next: function(e){
      L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
      this.stop(); this.showFrame(this.animationPosition + 1);
    },

    // ---------- time util ----------
    _snap3hUTC: function(d){
      const h=d.getUTCHours();
      const slot = h<=3?3:h<=6?6:h<=9?9:h<=12?12:h<=15?15:h<=18?18:h<=21?21:24;
      const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slot%24, 0, 0));
      if (slot===24) out.setUTCDate(out.getUTCDate()+1);
      return out;
    }
  });

  // factory
  L.control.inaflowsviewer = function(opts){ return new L.Control.inaflowsviewer(opts); };
}));
