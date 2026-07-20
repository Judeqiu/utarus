/**
 * Floor-plan-3d guest — classic IIFE, utarus-widget bridge.
 * Uses THREE global from vendor/three.min.js when present; else canvas 2D.
 */
(function () {
  'use strict';

  var CHANNEL = 'utarus-widget';
  var instanceId = null;
  var revision = 0;
  var state = {
    rooms: [],
    levels: 1,
    camera: { theta: 0.9, phi: 0.7, radius: 14 },
    highlightRoomId: null,
  };
  var props = {};
  var readySent = false;

  var statusEl = document.getElementById('status');
  var errEl = document.getElementById('err');
  var unitEl = document.getElementById('unitLabel');
  var canvas = document.getElementById('c');

  function setStatus(t) {
    if (statusEl) statusEl.textContent = t;
  }
  function setError(t) {
    if (!errEl) return;
    if (!t) {
      errEl.style.display = 'none';
      errEl.textContent = '';
      return;
    }
    errEl.style.display = 'block';
    errEl.textContent = t;
  }

  function post(msg) {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage(msg, '*');
  }

  function sendReady() {
    if (readySent || !instanceId) return;
    readySent = true;
    post({ channel: CHANNEL, type: 'ready', instanceId: instanceId });
    setStatus('ready · rev ' + revision);
  }

  function saveState() {
    if (!instanceId) return;
    post({
      channel: CHANNEL,
      type: 'state_save',
      instanceId: instanceId,
      expectedRevision: revision,
      data: {
        rooms: state.rooms,
        levels: state.levels,
        camera: state.camera,
        highlightRoomId: state.highlightRoomId,
      },
    });
    setStatus('saving…');
  }

  // ─── Renderer (Three or 2D fallback) ─────────────────────────────
  var hasThree = typeof window.THREE !== 'undefined';
  var three = {
    renderer: null,
    scene: null,
    camera: null,
    meshes: [],
  };

  function roomColor(id, highlight) {
    if (highlight && id === highlight) return 0xfbbf24;
    var palette = [0x60a5fa, 0x34d399, 0xf472b6, 0xa78bfa, 0xfb7185];
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h + id.charCodeAt(i) * 17) % palette.length;
    return palette[h];
  }

  function rebuildThree() {
    var THREE = window.THREE;
    if (!three.scene) {
      three.scene = new THREE.Scene();
      three.scene.background = new THREE.Color(0x0f1115);
      three.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
      three.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      three.renderer.setPixelRatio(window.devicePixelRatio || 1);
      var light = new THREE.DirectionalLight(0xffffff, 1.1);
      light.position.set(5, 10, 7);
      three.scene.add(light);
      three.scene.add(new THREE.AmbientLight(0xffffff, 0.35));
      var grid = new THREE.GridHelper(20, 20, 0x44403c, 0x292524);
      three.scene.add(grid);
    }
    // clear old room meshes
    three.meshes.forEach(function (m) {
      three.scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    });
    three.meshes = [];

    (state.rooms || []).forEach(function (room) {
      var poly = room.polygon || [];
      if (poly.length < 3) return;
      var shape = new THREE.Shape();
      shape.moveTo(poly[0][0], poly[0][1]);
      for (var i = 1; i < poly.length; i++) shape.lineTo(poly[i][0], poly[i][1]);
      shape.closePath();
      var geo = new THREE.ExtrudeGeometry(shape, { depth: 2.4, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      var mat = new THREE.MeshStandardMaterial({
        color: roomColor(room.id, state.highlightRoomId),
        transparent: true,
        opacity: 0.9,
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.userData.roomId = room.id;
      three.scene.add(mesh);
      three.meshes.push(mesh);
    });
    applyCameraThree();
    resizeThree();
    three.renderer.render(three.scene, three.camera);
  }

  function applyCameraThree() {
    var cam = state.camera || { theta: 0.9, phi: 0.7, radius: 14 };
    var theta = cam.theta;
    var phi = Math.max(0.15, Math.min(1.4, cam.phi));
    var r = Math.max(4, cam.radius);
    three.camera.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi) * Math.sin(theta),
    );
    three.camera.lookAt(2, 0, 2);
  }

  function resizeThree() {
    if (!three.renderer) return;
    var w = canvas.clientWidth || canvas.parentElement.clientWidth;
    var h = canvas.clientHeight || canvas.parentElement.clientHeight;
    if (w < 1 || h < 1) return;
    three.renderer.setSize(w, h, false);
    three.camera.aspect = w / h;
    three.camera.updateProjectionMatrix();
  }

  function render2d() {
    var w = canvas.clientWidth || 400;
    var h = canvas.clientHeight || 300;
    canvas.width = w * (window.devicePixelRatio || 1);
    canvas.height = h * (window.devicePixelRatio || 1);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, w, h);
    var cam = state.camera || { theta: 0, phi: 0.7, radius: 14 };
    var scale = Math.min(w, h) / (cam.radius * 0.9);
    var ox = w / 2;
    var oy = h / 2;
    (state.rooms || []).forEach(function (room) {
      var poly = room.polygon || [];
      if (poly.length < 2) return;
      ctx.beginPath();
      poly.forEach(function (p, i) {
        var x = ox + (p[0] - 2) * scale;
        var y = oy + (p[1] - 2) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      var c = room.id === state.highlightRoomId ? '#fbbf24' : '#60a5fa';
      ctx.fillStyle = c;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#e7e5e4';
      ctx.stroke();
      ctx.fillStyle = '#fafaf9';
      ctx.font = '12px system-ui';
      var cx = ox + (((poly[0][0] + poly[2][0]) / 2) - 2) * scale;
      var cy = oy + (((poly[0][1] + poly[2][1]) / 2) - 2) * scale;
      ctx.fillText(room.id, cx - 16, cy);
    });
  }

  function render() {
    if (hasThree) {
      applyCameraThree();
      three.renderer.render(three.scene, three.camera);
    } else {
      render2d();
    }
  }

  function applyState(data) {
    state = {
      rooms: (data && data.rooms) || [],
      levels: (data && data.levels) || 1,
      camera: (data && data.camera) || { theta: 0.9, phi: 0.7, radius: 14 },
      highlightRoomId: data && data.highlightRoomId != null ? data.highlightRoomId : null,
    };
    if (hasThree) rebuildThree();
    else render();
  }

  // pointer orbit
  var dragging = false;
  var lastX = 0;
  var lastY = 0;
  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.camera.theta += dx * 0.01;
    state.camera.phi = Math.max(0.15, Math.min(1.4, state.camera.phi + dy * 0.01));
    render();
  });
  canvas.addEventListener('pointerup', function () {
    dragging = false;
  });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    state.camera.radius = Math.max(4, Math.min(40, state.camera.radius + e.deltaY * 0.02));
    render();
  }, { passive: false });

  window.addEventListener('resize', function () {
    if (hasThree) {
      resizeThree();
      render();
    } else render();
  });

  document.getElementById('btnSave').addEventListener('click', function () {
    saveState();
  });
  document.getElementById('btnHighlight').addEventListener('click', function () {
    var rooms = state.rooms || [];
    if (!rooms.length) return;
    var ids = rooms.map(function (r) { return r.id; });
    var idx = ids.indexOf(state.highlightRoomId);
    state.highlightRoomId = ids[(idx + 1) % ids.length];
    if (hasThree) rebuildThree();
    else render();
  });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;
    if (data.type === 'init') {
      instanceId = data.instanceId;
      props = data.props || {};
      if (props.unitLabel) unitEl.textContent = String(props.unitLabel);
      if (data.state && data.state.data) {
        revision = data.state.revision;
        applyState(data.state.data);
      } else {
        applyState({});
      }
      sendReady();
      return;
    }
    if (data.type === 'update' && data.instanceId === instanceId) {
      if (data.props && data.props.unitLabel) unitEl.textContent = String(data.props.unitLabel);
      if (data.props && data.props.overlay && data.props.overlay.highlightRoomId) {
        state.highlightRoomId = data.props.overlay.highlightRoomId;
      }
      if (data.state) {
        revision = data.state.revision;
        applyState(data.state.data);
      } else if (hasThree) rebuildThree();
      else render();
      return;
    }
    if (data.type === 'state_saved' && data.instanceId === instanceId) {
      revision = data.revision;
      setStatus('saved · rev ' + revision);
      setError(null);
      return;
    }
    if (data.type === 'state_error' && data.instanceId === instanceId) {
      setError(data.message || data.code);
      setStatus('save failed');
      if (typeof data.currentRevision === 'number') revision = data.currentRevision;
    }
  });

  setStatus(hasThree ? 'three.js ready — waiting for host…' : 'canvas mode — waiting for host…');
})();
