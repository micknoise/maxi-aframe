// maxi-components.js
// Declarative Maximilian patching for A-Frame scenes.
(function () {
  'use strict';

  if (typeof AFRAME === 'undefined') {
    console.error('maxi-components: AFRAME is not loaded.');
    return;
  }

  var NODE_REGISTRY = [];

  function sanitizeId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9_]/g, '_');
  }

  function nv(id) {
    return '__' + sanitizeId(id);
  }

  function no(id) {
    return '__' + sanitizeId(id) + '_o';
  }

  function isRef(v) {
    return typeof v === 'string' && v.trim().charAt(0) === '#';
  }

  function asNum(v, fallback) {
    var n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function getRefId(sceneEl, selector) {
    if (!isRef(selector)) return null;
    var sel = String(selector).trim();
    var el = sceneEl.querySelector(sel);
    if (!el || !el.id) return null;
    return el.id;
  }

  function rp(sceneEl, v) {
    if (isRef(v)) {
      var refId = getRefId(sceneEl, v);
      return refId ? no(refId) : '0.0';
    }
    var n = Number(v);
    return Number.isFinite(n) ? String(n) : '0.0';
  }

  function topoSort(nodesById) {
    var ordered = [];
    var state = {}; // 0 unvisited, 1 visiting, 2 visited

    function visit(id, stack) {
      var st = state[id] || 0;
      if (st === 1) {
        throw new Error('Cycle detected: ' + stack.concat([id]).join(' -> '));
      }
      if (st === 2) return;
      state[id] = 1;
      var node = nodesById[id];
      var deps = node._getDeps ? node._getDeps() : [];
      for (var i = 0; i < deps.length; i++) {
        var depId = deps[i];
        if (!nodesById[depId]) {
          throw new Error('Missing dependency #' + depId + ' for #' + id);
        }
        visit(depId, stack.concat([id]));
      }
      state[id] = 2;
      ordered.push(node);
    }

    var ids = Object.keys(nodesById);
    for (var i = 0; i < ids.length; i++) {
      visit(ids[i], []);
    }
    return ordered;
  }

  function registerNode(comp) {
    if (NODE_REGISTRY.indexOf(comp) === -1) NODE_REGISTRY.push(comp);
    var sceneEl = comp.el && comp.el.sceneEl;
    if (sceneEl && sceneEl.systems && sceneEl.systems['maxi-patch']) {
      sceneEl.systems['maxi-patch'].requestCompile();
    }
  }

  function unregisterNode(comp) {
    var idx = NODE_REGISTRY.indexOf(comp);
    if (idx !== -1) NODE_REGISTRY.splice(idx, 1);
    var sceneEl = comp.el && comp.el.sceneEl;
    if (sceneEl && sceneEl.systems && sceneEl.systems['maxi-patch']) {
      sceneEl.systems['maxi-patch'].requestCompile();
    }
  }

  function clamp01(n) {
    return Math.max(0, Math.min(1, n));
  }

  function makeComp(def) {
    return {
      schema: def.schema,
      init: function () {
        registerNode(this);
        if (def.onInit) def.onInit.call(this);
      },
      update: function () {
        if (def.onUpdate) def.onUpdate.call(this);
        var sceneEl = this.el && this.el.sceneEl;
        if (sceneEl && sceneEl.systems && sceneEl.systems['maxi-patch']) {
          sceneEl.systems['maxi-patch'].requestCompile();
        }
      },
      remove: function () {
        unregisterNode(this);
      },
      _getDeps: function () {
        return def.getDeps ? def.getDeps.call(this) : [];
      },
      _genDecls: function () {
        return def.genDecls ? def.genDecls.call(this) : null;
      },
      _genSetup: function () {
        return def.genSetup ? def.genSetup.call(this) : [];
      },
      _genPlay: function () {
        return def.genPlay ? def.genPlay.call(this) : [];
      }
    };
  }

  AFRAME.registerSystem('maxi-patch', {
    schema: {
      output: { type: 'string', default: '#out' },
      libsPath: { type: 'string', default: '' }
    },

    init: function () {
      var self = this;
      var FFT_BINS = 256;

      this._maxi = null;
      this._engineReady = false;
      this._playing = false;
      this._compileTimer = 0;
      this._compileError = null;
      this._pendingDepsWarned = false;
      this._lastCode = '';
      this._loadedSamples = {};
      this._loadingSamples = {};
      this._sampleQueue = {};

      this._fftData = new Uint8Array(FFT_BINS * 4);
      this.fftTexture = new THREE.DataTexture(this._fftData, FFT_BINS, 1, THREE.RGBAFormat);
      this.fftTexture.magFilter = THREE.NearestFilter;
      this.fftTexture.minFilter = THREE.NearestFilter;
      this.fftTexture.needsUpdate = true;
      window.jazzFFTTexture = this.fftTexture;
      window.jazzRMS = 0;
      window.jazzRotDir = [1, 1, 1];

      this._analyser = null;
      this._floatFreqData = null;
      this._linArray = new Float32Array(FFT_BINS);
      this._sampleRate = 44100;
      this._rmsSmooth = 0;

      var playBtn = document.getElementById('playButton');
      if (playBtn) {
        playBtn.textContent = 'loading...';
        playBtn.disabled = true;
      }

      var libsPath = this.data.libsPath && this.data.libsPath.length
        ? this.data.libsPath
        : new URL('./libs', document.location.href).href;

      initAudioEngine(libsPath)
        .then(function (maxi) {
          self._maxi = maxi;
          self._engineReady = true;

          var ctx = maxi.audioWorkletNode.context;
          ctx.suspend();
          self._sampleRate = ctx.sampleRate;

          var analyser = ctx.createAnalyser();
          analyser.fftSize = FFT_BINS * 2;
          self._analyser = analyser;
          self._floatFreqData = new Float32Array(analyser.frequencyBinCount);

          var gainNode = ctx.createGain();
          gainNode.gain.value = 1.0;
          try { maxi.audioWorkletNode.disconnect(); } catch (e) {}
          maxi.audioWorkletNode.connect(gainNode);
          gainNode.connect(ctx.destination);
          maxi.audioWorkletNode.connect(analyser);

          window.jazzSetVolume = function (v) {
            gainNode.gain.value = Math.max(0, Math.min(1, Number(v) || 0));
          };

          self._flushSampleQueue();

          self.compileNow();

          if (playBtn) {
            playBtn.textContent = 'play';
            playBtn.disabled = false;
            playBtn.addEventListener('click', function () {
              if (!self._engineReady || !self._maxi) return;
              if (!self._playing) {
                self._maxi.play();
                self._playing = true;
                playBtn.textContent = 'stop';
              } else {
                self._maxi.audioWorkletNode.context.suspend();
                self._playing = false;
                playBtn.textContent = 'play';
              }
            });
          }
        })
        .catch(function (err) {
          console.error('maxi-patch: failed to init audio engine', err);
          if (playBtn) {
            playBtn.textContent = 'reload';
            playBtn.disabled = false;
            playBtn.addEventListener('click', function () { window.location.reload(); });
          }
        });
    },

    queueSample: function (name, url) {
      if (!name || !url) return;
      this._sampleQueue[name] = url;
      if (this._engineReady) this._flushSampleQueue();
    },

    _flushSampleQueue: function () {
      var names = Object.keys(this._sampleQueue);
      for (var i = 0; i < names.length; i++) {
        let name = names[i];
        let url = this._sampleQueue[name];
        if (!url) continue;
        if (this._loadedSamples[name] || this._loadingSamples[name]) continue;

        var self = this;
        let absUrl = new URL(url, document.location.href).href;
  // maxi-processor normalizes sample names by stripping the last 4 chars.
  // Use the historic "----" suffix so "beat----" becomes "beat" in buffer keys.
  let loadName = name.endsWith('----') ? name : (name + '----');
  this._loadingSamples[name] = this._maxi.loadSample(loadName, absUrl, true)
          .then(function () {
            self._loadedSamples[name] = true;
            delete self._loadingSamples[name];
            // Re-run setup so maxiSample binds the now-ready sample buffer.
            self._lastCode = '';
            self.requestCompile();
          })
          .catch(function (err) {
            console.error('maxi-patch sample load failed:', name, err);
            delete self._loadingSamples[name];
          });
      }
    },

    tick: function () {
      if (!this._analyser) return;

      var FFT_BINS = 256;
      this._analyser.getFloatFrequencyData(this._floatFreqData);

      var peak = 0;
      for (var i = 0; i < FFT_BINS; i++) {
        var db = this._floatFreqData[i];
        var lin = (isFinite(db) && db > -200) ? Math.pow(10, db / 20) : 0;
        this._linArray[i] = lin;
        if (lin > peak) peak = lin;
      }

      var rawRms = 0;
      for (var j = 0; j < FFT_BINS; j++) rawRms += this._linArray[j] * this._linArray[j];
      rawRms = Math.sqrt(rawRms / FFT_BINS);
      this._rmsSmooth = this._rmsSmooth * 0.88 + rawRms * 0.12;
      window.jazzRMS = this._rmsSmooth;

      var inv = peak > 0.000001 ? 1 / peak : 0;
      for (var k = 0; k < FFT_BINS; k++) {
        var val = Math.min(255, Math.floor(this._linArray[k] * inv * 255));
        this._fftData[k * 4] = val;
        this._fftData[k * 4 + 1] = val;
        this._fftData[k * 4 + 2] = val;
        this._fftData[k * 4 + 3] = 255;
      }
      this.fftTexture.needsUpdate = true;
    },

    requestCompile: function () {
      var self = this;
      if (this._compileTimer) clearTimeout(this._compileTimer);
      this._compileTimer = setTimeout(function () {
        self.compileNow();
      }, 100);
    },

    _collectNodes: function () {
      var sceneEl = this.el;
      var all = NODE_REGISTRY.filter(function (n) {
        return n && n.el && n.el.sceneEl === sceneEl && n.el.id;
      });
      var byId = {};
      for (var i = 0; i < all.length; i++) {
        var id = all[i].el.id;
        if (byId[id]) throw new Error('Duplicate node id #' + id);
        byId[id] = all[i];
      }
      return byId;
    },

    _buildDSP: function () {
      var byId = this._collectNodes();
      var ordered = topoSort(byId);

      var outId = getRefId(this.el, this.data.output);
      if (!outId) {
        throw new Error('Output selector does not resolve: ' + this.data.output);
      }
      if (!byId[outId]) {
        throw new Error('Output node is not a maxi component: #' + outId);
      }

      var decls = [];
      var setup = [];
      var play = [];

      for (var i = 0; i < ordered.length; i++) {
        var node = ordered[i];
        var d = node._genDecls();
        if (d) decls.push(d);
        var s = node._genSetup();
        if (s && s.length) setup = setup.concat(s);
      }

      for (var j = 0; j < ordered.length; j++) {
        var p = ordered[j]._genPlay();
        if (p && p.length) play = play.concat(p);
      }
      play.push('return ' + no(outId) + ';');

      return decls.concat(setup).concat(['function play() {']).concat(play.map(function (l) { return '  ' + l; })).concat(['}']).join('\n');
    },

    compileNow: function () {
      if (!this._engineReady || !this._maxi) return;
      try {
        var code = this._buildDSP();
        if (code === this._lastCode) return;
        var wasPlaying = this._playing;
        var ctx = this._maxi.audioWorkletNode && this._maxi.audioWorkletNode.context;

        if (ctx && wasPlaying) ctx.suspend();
        this._maxi.setAudioCode(code);
        if (ctx && wasPlaying) {
          this._maxi.play();
        }

        this._lastCode = code;
        this._compileError = null;
        this._pendingDepsWarned = false;
        console.info('maxi-patch: compiled OK');
      } catch (err) {
        var msg = String((err && err.message) ? err.message : err);
        if (msg.indexOf('Missing dependency #') !== -1) {
          // A-Frame init order can trigger compile before all components register.
          // Treat this as transient and retry shortly.
          if (!this._pendingDepsWarned) {
            console.warn('maxi-patch: waiting for remaining nodes before compile');
            this._pendingDepsWarned = true;
          }
          this.requestCompile();
          return;
        }
        this._compileError = err;
        console.error('maxi-patch compile failed:', err.message || err);
      }
    }
  });

  AFRAME.registerComponent('maxi-osc', makeComp({
    schema: {
      type: { type: 'string', default: 'sinewave' },
      freq: { type: 'string', default: '440' },
      duty: { type: 'string', default: '0.5' },
      scale: { type: 'string', default: '1' },
      offset: { type: 'string', default: '0' }
    },
    getDeps: function () {
      var deps = [];
      if (isRef(this.data.freq)) {
        var id = getRefId(this.el.sceneEl, this.data.freq);
        if (id) deps.push(id);
      }
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiOsc();';
    },
    genPlay: function () {
      var t = this.data.type;
      var o = nv(this.el.id);
      var out = no(this.el.id);
      var freq = rp(this.el.sceneEl, this.data.freq);
      var sig;

      if (t === 'pulse') {
        sig = o + '.pulse(' + freq + ', ' + rp(this.el.sceneEl, this.data.duty) + ')';
      } else if (t === 'noise') {
        sig = o + '.noise()';
      } else if (t === 'impulse') {
        sig = o + '.impulse(' + freq + ')';
      } else {
        var method = {
          sinewave: 'sinewave',
          coswave: 'coswave',
          phasor: 'phasor',
          square: 'square',
          saw: 'saw',
          sawn: 'sawn',
          triangle: 'triangle'
        }[t] || 'sinewave';
        sig = o + '.' + method + '(' + freq + ')';
      }

      return [
        'var ' + out + ' = (' + sig + ') * ' + rp(this.el.sceneEl, this.data.scale) + ' + ' + rp(this.el.sceneEl, this.data.offset) + ';'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-blep', makeComp({
    schema: {
      type: { type: 'string', default: 'saw' },
      freq: { type: 'string', default: '440' },
      duty: { type: 'string', default: '0.5' },
      scale: { type: 'string', default: '1' },
      offset: { type: 'string', default: '0' }
    },
    getDeps: function () {
      var deps = [];
      ['freq', 'duty', 'scale', 'offset'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiPolyBLEP();';
    },
    genSetup: function () {
      var waveforms = {
        sin: 0,
        cosine: 1,
        triangle: 2,
        square: 3,
        rect: 4,
        saw: 5,
        ramp: 6
      };
      var wf = waveforms[this.data.type] !== undefined ? waveforms[this.data.type] : 5;
      return [
        nv(this.el.id) + '.setWaveform(' + wf + ');'
      ];
    },
    genPlay: function () {
      var o = nv(this.el.id);
      var out = no(this.el.id);
      return [
        o + '.setPulseWidth(' + rp(this.el.sceneEl, this.data.duty) + ');',
        'var ' + out + ' = (' + o + '.play(' + rp(this.el.sceneEl, this.data.freq) + ')) * ' + rp(this.el.sceneEl, this.data.scale) + ' + ' + rp(this.el.sceneEl, this.data.offset) + ';'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-clock', makeComp({
    schema: {
      tempo: { type: 'number', default: 120 },
      ticksPerBeat: { type: 'number', default: 4 }
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiClock();';
    },
    genSetup: function () {
      var o = nv(this.el.id);
      return [
        o + '.setTempo(' + asNum(this.data.tempo, 120) + ');',
        o + '.setTicksPerBeat(' + asNum(this.data.ticksPerBeat, 4) + ');'
      ];
    },
    genPlay: function () {
      var o = nv(this.el.id);
      var out = no(this.el.id);
      return [
        o + '.ticker();',
        'var ' + out + ' = ' + o + '.tick ? 1.0 : 0.0;'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-filter', makeComp({
    schema: {
      type: { type: 'string', default: 'lores' },
      input: { type: 'string', default: '0' },
      cutoff: { type: 'string', default: '800' },
      resonance: { type: 'string', default: '0.5' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'cutoff', 'resonance'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiFilter();';
    },
    genPlay: function () {
      var method = ({ lores: 'lores', hires: 'hires', lopass: 'lopass', hipass: 'hipass' })[this.data.type] || 'lores';
      var out = no(this.el.id);
      var o = nv(this.el.id);
      var cutoff = 'Math.max(20, ' + rp(this.el.sceneEl, this.data.cutoff) + ')';
      if (method === 'lores' || method === 'hires') {
        return ['var ' + out + ' = ' + o + '.' + method + '(' + rp(this.el.sceneEl, this.data.input) + ', ' + cutoff + ', ' + rp(this.el.sceneEl, this.data.resonance) + ');'];
      }
      return ['var ' + out + ' = ' + o + '.' + method + '(' + rp(this.el.sceneEl, this.data.input) + ', ' + cutoff + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-svf', makeComp({
    schema: {
      input: { type: 'string', default: '0' },
      cutoff: { type: 'string', default: '800' },
      resonance: { type: 'string', default: '1' },
      lp: { type: 'string', default: '1' },
      hp: { type: 'string', default: '0' },
      bp: { type: 'string', default: '0' },
      notch: { type: 'string', default: '0' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'cutoff', 'resonance', 'lp', 'hp', 'bp', 'notch'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiSVF();';
    },
    genPlay: function () {
      var o = nv(this.el.id);
      var out = no(this.el.id);
      var cutExpr = rp(this.el.sceneEl, this.data.cutoff);
      var resExpr = rp(this.el.sceneEl, this.data.resonance);
      return [
        'var ' + o + '_cut = Math.max(20, Math.min(20000, ' + cutExpr + '));',
        'var ' + o + '_res = Math.max(0.0001, ' + resExpr + ');',
        o + '.setCutoff(' + o + '_cut);',
        o + '.setResonance(' + o + '_res);',
        'var ' + out + ' = ' + o + '.play(' + rp(this.el.sceneEl, this.data.input) + ', ' + rp(this.el.sceneEl, this.data.lp) + ', ' + rp(this.el.sceneEl, this.data.hp) + ', ' + rp(this.el.sceneEl, this.data.bp) + ', ' + rp(this.el.sceneEl, this.data.notch) + ');'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-env', makeComp({
    schema: {
      type: { type: 'string', default: 'adsr' },
      input: { type: 'string', default: '1' },
      trigger: { type: 'string', default: '1' },
      attack: { type: 'string', default: '10' },
      decay: { type: 'string', default: '100' },
      sustain: { type: 'string', default: '0.8' },
      release: { type: 'string', default: '300' },
      holdtime: { type: 'string', default: '4096' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'trigger', 'attack', 'decay', 'sustain', 'release', 'holdtime'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiEnv();';
    },
    genSetup: function () {
      var o = nv(this.el.id);
      var attack = Math.max(0, asNum(this.data.attack, 10));
      var decay = Math.max(1, asNum(this.data.decay, 100));
      var sustain = clamp01(asNum(this.data.sustain, 0.8));
      var release = Math.max(1, asNum(this.data.release, 300));

      if (String(this.data.type).toLowerCase() === 'ar') {
        // AR approximation in this binding: very short decay and full sustain.
        decay = 1;
        sustain = 1;
      }

      return [
        o + '.setAttack(' + attack + ');',
        o + '.setDecay(' + decay + ');',
        o + '.setSustain(' + sustain + ');',
        o + '.setRelease(' + release + ');'
      ];
    },
    genPlay: function () {
      var out = no(this.el.id);
      var o = nv(this.el.id);
      var input = rp(this.el.sceneEl, this.data.input);
      var trig = rp(this.el.sceneEl, this.data.trigger);
      return [
        'var ' + o + '_env = ' + o + '.adsr(1, ' + trig + ');',
        'var ' + out + ' = (' + input + ') * ' + o + '_env;'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-delay', makeComp({
    schema: {
      input: { type: 'string', default: '0' },
      delay: { type: 'string', default: '2205' },
      feedback: { type: 'string', default: '0.5' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'delay', 'feedback'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiDelayline();';
    },
    genPlay: function () {
      return ['var ' + no(this.el.id) + ' = ' + nv(this.el.id) + '.dl(' + rp(this.el.sceneEl, this.data.input) + ', ' + rp(this.el.sceneEl, this.data.delay) + ', ' + rp(this.el.sceneEl, this.data.feedback) + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-distortion', makeComp({
    schema: {
      type: { type: 'string', default: 'atanDist' },
      input: { type: 'string', default: '0' },
      amount: { type: 'string', default: '1' },
      asymmetry: { type: 'string', default: '0.2' },
      hardness: { type: 'string', default: '1' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'amount', 'asymmetry', 'hardness'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiNonlinearity();';
    },
    genPlay: function () {
      var o = nv(this.el.id);
      var out = no(this.el.id);
      var input = rp(this.el.sceneEl, this.data.input);
      var amount = rp(this.el.sceneEl, this.data.amount);
      var t = this.data.type;
      if (t === 'softclip') return ['var ' + out + ' = ' + o + '.softclip(' + input + ');'];
      if (t === 'hardclip') return ['var ' + out + ' = ' + o + '.hardclip(' + input + ');'];
      if (t === 'asymclip') return ['var ' + out + ' = ' + o + '.asymclip(' + input + ', ' + rp(this.el.sceneEl, this.data.asymmetry) + ', ' + rp(this.el.sceneEl, this.data.hardness) + ');'];
      return ['var ' + out + ' = ' + o + '.atanDist(' + input + ', ' + amount + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-chorus', makeComp({
    schema: {
      input: { type: 'string', default: '0' },
      delayLength: { type: 'string', default: '40' },
      lfoSpeed: { type: 'string', default: '0.6' },
      lfoDepth: { type: 'string', default: '0.8' },
      mix: { type: 'string', default: '0.5' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'delayLength', 'lfoSpeed', 'lfoDepth', 'mix'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiChorus();';
    },
    genPlay: function () {
      return ['var ' + no(this.el.id) + ' = ' + nv(this.el.id) + '.chorus(' + rp(this.el.sceneEl, this.data.input) + ', ' + rp(this.el.sceneEl, this.data.delayLength) + ', ' + rp(this.el.sceneEl, this.data.lfoSpeed) + ', ' + rp(this.el.sceneEl, this.data.lfoDepth) + ', ' + rp(this.el.sceneEl, this.data.mix) + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-flanger', makeComp({
    schema: {
      input: { type: 'string', default: '0' },
      delayLength: { type: 'string', default: '40' },
      lfoSpeed: { type: 'string', default: '0.6' },
      lfoDepth: { type: 'string', default: '0.8' },
      mix: { type: 'string', default: '0.5' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'delayLength', 'lfoSpeed', 'lfoDepth', 'mix'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      return 'var ' + nv(this.el.id) + ' = new Maximilian.maxiFlanger();';
    },
    genPlay: function () {
      return ['var ' + no(this.el.id) + ' = ' + nv(this.el.id) + '.flange(' + rp(this.el.sceneEl, this.data.input) + ', ' + rp(this.el.sceneEl, this.data.delayLength) + ', ' + rp(this.el.sceneEl, this.data.lfoSpeed) + ', ' + rp(this.el.sceneEl, this.data.lfoDepth) + ', ' + rp(this.el.sceneEl, this.data.mix) + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-gain', makeComp({
    schema: {
      input: { type: 'string', default: '0' },
      gain: { type: 'string', default: '1' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'gain'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genPlay: function () {
      return ['var ' + no(this.el.id) + ' = ' + rp(this.el.sceneEl, this.data.input) + ' * ' + rp(this.el.sceneEl, this.data.gain) + ';'];
    }
  }));

  AFRAME.registerComponent('maxi-add', makeComp({
    schema: {
      a: { type: 'string', default: '0' },
      b: { type: 'string', default: '0' },
      mix: { type: 'string', default: '0.5' }
    },
    getDeps: function () {
      var deps = [];
      ['a', 'b', 'mix'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genPlay: function () {
      var m = rp(this.el.sceneEl, this.data.mix);
      var a = rp(this.el.sceneEl, this.data.a);
      var b = rp(this.el.sceneEl, this.data.b);
      return ['var ' + no(this.el.id) + ' = (' + a + ' * (1 - ' + m + ')) + (' + b + ' * ' + m + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-map', makeComp({
    schema: {
      type: { type: 'string', default: 'linlin' },
      input: { type: 'string', default: '0' },
      inMin: { type: 'string', default: '0' },
      inMax: { type: 'string', default: '1' },
      outMin: { type: 'string', default: '0' },
      outMax: { type: 'string', default: '1' }
    },
    getDeps: function () {
      var deps = [];
      ['input', 'inMin', 'inMax', 'outMin', 'outMax'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genPlay: function () {
      var fn = this.data.type === 'linexp' ? 'linexp' : 'linlin';
      var input = rp(this.el.sceneEl, this.data.input);
      return ['var ' + no(this.el.id) + ' = Maximilian.maxiMap.' + fn + '(' + input + ', ' + rp(this.el.sceneEl, this.data.inMin) + ', ' + rp(this.el.sceneEl, this.data.inMax) + ', ' + rp(this.el.sceneEl, this.data.outMin) + ', ' + rp(this.el.sceneEl, this.data.outMax) + ');'];
    }
  }));

  AFRAME.registerComponent('maxi-sample', makeComp({
    schema: {
      name: { type: 'string', default: 'sample1' },
      url: { type: 'string', default: '' },
      mode: { type: 'string', default: 'oneshot' },
      trigger: { type: 'string', default: '1' },
      speed: { type: 'string', default: '1' },
      offset: { type: 'string', default: '0' },
      gain: { type: 'string', default: '1' }
    },
    onInit: function () {
      var sceneEl = this.el && this.el.sceneEl;
      var patch = sceneEl && sceneEl.systems ? sceneEl.systems['maxi-patch'] : null;
      if (patch) patch.queueSample(this.data.name, this.data.url);
    },
    onUpdate: function () {
      var sceneEl = this.el && this.el.sceneEl;
      var patch = sceneEl && sceneEl.systems ? sceneEl.systems['maxi-patch'] : null;
      if (patch) patch.queueSample(this.data.name, this.data.url);
    },
    getDeps: function () {
      var deps = [];
      ['trigger', 'speed', 'offset', 'gain'].forEach(function (k) {
        if (isRef(this.data[k])) {
          var id = getRefId(this.el.sceneEl, this.data[k]);
          if (id) deps.push(id);
        }
      }, this);
      return deps;
    },
    genDecls: function () {
      var o = nv(this.el.id);
      var name = JSON.stringify(this.data.name || 'sample1');
      return [
        'var ' + o + ' = new Maximilian.maxiSample();',
        o + '.setSample(this.getSampleBuffer(' + name + '));'
      ].join('\n');
    },
    genPlay: function () {
      var o = nv(this.el.id);
      var out = no(this.el.id);
      var mode = (this.data.mode || 'oneshot').toLowerCase();
      var trig = rp(this.el.sceneEl, this.data.trigger);
      var speed = rp(this.el.sceneEl, this.data.speed);
      var offset = rp(this.el.sceneEl, this.data.offset);
      var body;

      if (mode === 'loop') {
        body = o + '.play(' + speed + ')';
      } else if (mode === 'speed') {
        body = o + '.playOnZXAtSpeed(' + trig + ', ' + speed + ')';
      } else if (mode === 'offset') {
        body = o + '.playOnZXAtSpeedFromOffset(' + trig + ', ' + speed + ', ' + offset + ')';
      } else {
        body = o + '.playOnZX(' + trig + ')';
      }

      return [
        'var ' + out + ' = (' + o + '.isReady() ? (' + body + ') : 0.0) * ' + rp(this.el.sceneEl, this.data.gain) + ';'
      ];
    }
  }));

  AFRAME.registerComponent('maxi-rms-scale', {
    schema: {
      min: { type: 'number', default: 0.9 },
      max: { type: 'number', default: 1.6 },
      smoothing: { type: 'number', default: 0.88 }
    },
    init: function () {
      this._smooth = this.data.min;
      this.el.object3D.scale.set(this.data.min, this.data.min, this.data.min);
    },
    tick: function () {
      var rms = Number(window.jazzRMS || 0);
      var target = this.data.min + Math.min(1, Math.max(0, rms * 8)) * (this.data.max - this.data.min);
      var a = Math.min(0.99, Math.max(0.0, this.data.smoothing));
      this._smooth = this._smooth * a + target * (1 - a);
      this.el.object3D.scale.set(this._smooth, this._smooth, this._smooth);
    }
  });

  AFRAME.registerComponent('maxi-audio-deform', {
    // Rows are auto-detected from the geometry (unique Y-value clusters = rows).
    // FFT bins are evenly mapped: row 0 → bin 0, row N-1 → bin (bins-1).
    // Works on any A-Frame geometry — spheres, planes, cylinders, custom meshes.
    schema: {
      amount:       { type: 'number', default: 1.7 },
      attack:       { type: 'number', default: 0.14 },
      release:      { type: 'number', default: 0.3 },
      gate:         { type: 'number', default: 0.015 },
      fftPower:     { type: 'number', default: 0.9 },
      binSmoothing: { type: 'number', default: 0.55 }
    },

    init: function () {
      this._mesh     = null;
      this._posAttr  = null;
      this._normAttr = null;
      this._basePos  = null;
      this._baseNorm = null;
      this._vertexRow = null;
      this._numRows  = 0;
      this._rowEnv   = null;
      this._bindMesh();
    },

    update: function () {
      // Force re-detect if component params change (amount etc. don't need rebind,
      // but a safe no-op since _bindMesh guards on mesh identity).
      this._bindMesh();
    },

    _findMesh: function () {
      var root = this.el.getObject3D('mesh');
      if (!root) return null;
      if (root.isMesh) return root;
      var found = null;
      root.traverse(function (obj) { if (!found && obj.isMesh) found = obj; });
      return found;
    },

    _bindMesh: function () {
      var mesh = this._findMesh();
      if (!mesh || !mesh.geometry || !mesh.geometry.attributes ||
          !mesh.geometry.attributes.position) return;
      if (mesh === this._mesh && this._posAttr) return;

      this._mesh     = mesh;
      this._posAttr  = mesh.geometry.attributes.position;
      this._normAttr = mesh.geometry.attributes.normal || null;
      this._basePos  = new Float32Array(this._posAttr.array);
      this._baseNorm = this._normAttr ? new Float32Array(this._normAttr.array) : null;

      var count = this._posAttr.count;

      // --- Detect rows by clustering unique Y values from the geometry ---
      // Each unique Y level = one row; FFT bins map evenly across all rows.
      var yMin = Infinity, yMax = -Infinity;
      for (var i = 0; i < count; i++) {
        var y = this._basePos[i * 3 + 1];
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }

      var eps = (yMax - yMin) * 0.001 + 1e-6;

      // Collect and sort Y values, then de-dup within epsilon.
      var ySorted = new Float32Array(count);
      for (var j = 0; j < count; j++) ySorted[j] = this._basePos[j * 3 + 1];
      ySorted = Array.from(ySorted).sort(function (a, b) { return a - b; });

      var rowCenters = [ySorted[0]];
      for (var k = 1; k < ySorted.length; k++) {
        if (ySorted[k] - rowCenters[rowCenters.length - 1] > eps) {
          rowCenters.push(ySorted[k]);
        }
      }

      var numRows = rowCenters.length;
      this._numRows = numRows;
      this._rowEnv  = new Float32Array(numRows);

      // Assign each vertex its row by nearest Y center (binary search).
      this._vertexRow = new Uint16Array(count);
      for (var vi = 0; vi < count; vi++) {
        var vy = this._basePos[vi * 3 + 1];
        var lo = 0, hi = numRows - 1;
        while (lo < hi) {
          var mid = (lo + hi) >> 1;
          if (rowCenters[mid] < vy) lo = mid + 1; else hi = mid;
        }
        if (lo > 0 && Math.abs(rowCenters[lo - 1] - vy) < Math.abs(rowCenters[lo] - vy)) lo--;
        this._vertexRow[vi] = lo;
      }
    },

    tick: function () {
      if (!this._posAttr || !this._numRows) {
        this._bindMesh();
        if (!this._posAttr || !this._numRows) return;
      }

      var tex      = window.jazzFFTTexture;
      var binsData = tex && tex.image ? tex.image.data : null;
      var bins     = binsData ? Math.max(1, Math.floor(binsData.length / 4)) : 0;
      var numRows  = this._numRows;
      var attackA  = Math.min(0.995, Math.max(0.0, this.data.attack));
      var releaseA = Math.min(0.995, Math.max(0.0, this.data.release));
      var gate     = Math.min(0.9,   Math.max(0.0, this.data.gate));
      var fftPwr   = Math.max(0.1,   this.data.fftPower);
      var bSmooth  = Math.min(0.95,  Math.max(0.0, this.data.binSmoothing));

      // Update per-row envelope from FFT.
      // Each row consumes a contiguous FFT bin range so the full spectrum is used
      // even when there are fewer geometry rows than FFT bins.
      for (var row = 0; row < numRows; row++) {
        var raw = 0;
        if (bins > 0) {
          var b0 = Math.floor((row * bins) / numRows);
          var b1 = Math.floor(((row + 1) * bins) / numRows) - 1;
          if (b1 < b0) b1 = b0;
          if (b0 < 0) b0 = 0;
          if (b1 > bins - 1) b1 = bins - 1;

          var sum = 0;
          var n = 0;
          for (var b = b0; b <= b1; b++) {
            sum += binsData[b * 4] / 255;
            n++;
          }
          var cv = n > 0 ? (sum / n) : 0;
          var lv = b0 > 0        ? binsData[(b0 - 1) * 4] / 255 : cv;
          var rv = b1 < bins - 1 ? binsData[(b1 + 1) * 4] / 255 : cv;
          raw = cv * (1 - bSmooth) + ((lv + rv) * 0.5) * bSmooth;
        }
        if (raw <= gate) raw = 0;
        else raw = (raw - gate) / (1 - gate);
        raw = Math.pow(Math.max(0, raw), fftPwr);

        var prev = this._rowEnv[row] || 0;
        var a    = raw >= prev ? attackA : releaseA;
        this._rowEnv[row] = prev * a + raw * (1 - a);
      }

      // Apply displacement along vertex normal (or normalised position fallback).
      var arr   = this._posAttr.array;
      var count = this._posAttr.count;
      var amt   = this.data.amount;

      for (var i = 0; i < count; i++) {
        var i3 = i * 3;
        var bx = this._basePos[i3], by = this._basePos[i3 + 1], bz = this._basePos[i3 + 2];
        var nx, ny, nz;
        if (this._baseNorm) {
          nx = this._baseNorm[i3]; ny = this._baseNorm[i3 + 1]; nz = this._baseNorm[i3 + 2];
        } else {
          var len = Math.sqrt(bx * bx + by * by + bz * bz);
          if (len < 1e-6) { nx = 0; ny = 1; nz = 0; }
          else { nx = bx / len; ny = by / len; nz = bz / len; }
        }
        var disp = amt * (this._rowEnv[this._vertexRow[i]] || 0);
        arr[i3]     = bx + nx * disp;
        arr[i3 + 1] = by + ny * disp;
        arr[i3 + 2] = bz + nz * disp;
      }

      this._posAttr.needsUpdate = true;
    }
  });
})();
