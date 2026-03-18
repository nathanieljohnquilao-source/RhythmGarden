'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// RHYTHM GARDEN  ·  game.js
//
// Architecture:
//   · Web Audio API generates the beat procedurally (kick + hi-hat + melody)
//   · 6 plant slots each have a beat interval pattern (every 1, 2, or 3 beats)
//   · A timing ring animates inward — tap at the right moment
//   · PERFECT / GOOD / MISS with combo multiplier
//   · Plants drawn on canvas: 4 growth stages (seed→sprout→bloom→wilt)
//   · Tempo increases every 10s; difficulty ramps at score milestones
//   · Mobile + desktop: tap/click canvas at plant positions
// ═══════════════════════════════════════════════════════════════════════════════

/* ── DOM ─────────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const canvas        = $('gameCanvas');
const ctx           = canvas.getContext('2d');
const feedbackLayer = $('feedback-layer');

/* ── Screen management ───────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ── Constants ───────────────────────────────────────────────────────────── */
const COLS = 3, ROWS = 2;      // 3×2 plant grid
const NUM_PLANTS = COLS * ROWS; // 6

// Timing windows (fraction of beat interval) — tighter than you'd think
const WINDOW_PERFECT = 0.12;
const WINDOW_GOOD    = 0.22;

// Points
const PTS_PERFECT = 100;
const PTS_GOOD    = 50;
const COMBO_MULT  = [1, 1, 1.2, 1.5, 2, 2, 2.5, 3]; // index = Math.min(combo, 7)

// Plant types — each has a colour, shape, beat pattern, and name
const PLANT_TYPES = [
  { name:'SUNBLOSSOM', col:'#ffd93d', col2:'#ffb800', petals:8,  shape:'round'   },
  { name:'ROSEBUD',    col:'#ff6b9d', col2:'#e6005c', petals:5,  shape:'cup'     },
  { name:'CORALBELL',  col:'#ff8c69', col2:'#e05500', petals:6,  shape:'star'    },
  { name:'SKYBELL',    col:'#6bcfff', col2:'#0099e6', petals:4,  shape:'bell'    },
  { name:'MINTLEAF',   col:'#4dffa0', col2:'#00cc66', petals:3,  shape:'leaf'    },
  { name:'LILACPUFF',  col:'#c084fc', col2:'#8800dd', petals:10, shape:'puff'    },
];

// Beat patterns — when each plant wants a tap (in beats, 1=every beat)
const PATTERNS = [
  [1],     // every beat
  [2],     // every 2 beats
  [1],
  [3],     // every 3 beats
  [2],
  [1],
];

/* ── Web Audio ───────────────────────────────────────────────────────────── */
let audioCtx = null;
let masterGain = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.55;
  masterGain.connect(audioCtx.destination);
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

// Kick drum
function playKick(time) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain); gain.connect(masterGain);
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.08);
  gain.gain.setValueAtTime(0.9, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  osc.start(time); osc.stop(time + 0.2);
}

// Hi-hat
function playHat(time, open=false) {
  if (!audioCtx) return;
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = open ? 6000 : 9000;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(open ? 0.25 : 0.15, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + (open ? 0.18 : 0.06));
  src.connect(filter); filter.connect(gain); gain.connect(masterGain);
  src.start(time); src.stop(time + 0.2);
}

// Melodic tone (plays on successful taps)
function playTone(time, freq, vol=0.3) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(vol, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
  osc.connect(gain); gain.connect(masterGain);
  osc.start(time); osc.stop(time + 0.3);
}

// Note frequencies per plant (pentatonic scale — always sounds good)
const PLANT_FREQS = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50];

/* ── Game state ──────────────────────────────────────────────────────────── */
let G = null;
let animId = null;
let lastTs = 0;

function freshState() {
  return {
    phase: 'playing',   // playing | dead
    score: 0,
    combo: 0,
    maxCombo: 0,
    lives: 3,
    level: 1,
    totalPerfect: 0,
    totalGood: 0,
    totalMiss: 0,

    // Timing
    bpm: 90,
    beatInterval: 60 / 90,  // seconds per beat
    beatClock: 0,            // seconds since last beat
    beatCount: 0,            // total beats elapsed
    beatFlash: 0,            // countdown for beat ring flash

    // Plants
    plants: Array.from({ length: NUM_PLANTS }, (_, i) => freshPlant(i)),

    // Visual
    particles: [],
    screenShake: 0,
    bgPulse: 0,
  };
}

function freshPlant(idx) {
  const type = PLANT_TYPES[idx];
  const pattern = PATTERNS[idx];
  return {
    idx,
    type,
    pattern,
    stage: 1,         // 1=seed, 2=sprout, 3=bloom, 4=wilt
    beatPhase: 0,     // which beat in the pattern we're at
    nextBeatIn: pattern[0], // beats until next tap needed
    ringRadius: 0,    // 0-1 (1=full size, shrinks to center)
    ringActive: false,
    ringStartTime: 0,
    ringDuration: 0,
    tapped: false,    // locked after tap until next ring
    hitResult: null,  // 'perfect'|'good'|'miss' — for visual
    hitTimer: 0,
    wobble: 0,        // animation wobble after tap
    wiltTimer: 0,
    growTimer: 0,     // growing animation
    bobOffset: Math.random() * Math.PI * 2, // idle bob phase
  };
}

/* ── Layout ──────────────────────────────────────────────────────────────── */
const HH = 64;
let plantPositions = []; // [{x,y,r}] — centre + tap radius

function resize() {
  const W = window.innerWidth;
  const H = window.innerHeight - HH;
  canvas.width  = W;
  canvas.height = H;
  canvas.style.top  = HH + 'px';
  canvas.style.left = '0px';

  // Layout 3×2 grid, centered, with generous padding
  const colW = W / COLS;
  const rowH = H / ROWS;
  const r    = Math.min(colW, rowH) * 0.36; // tap radius

  plantPositions = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      plantPositions[idx] = {
        x: colW * col + colW / 2,
        y: rowH * row + rowH / 2,
        r,
        colW, rowH,
      };
    }
  }
}
window.addEventListener('resize', resize);

/* ── High score ──────────────────────────────────────────────────────────── */
const getBest  = ()  => parseInt(localStorage.getItem('rg_best') || '0');
const saveBest = (s) => { if (s > getBest()) localStorage.setItem('rg_best', s); };
function updateTitleBest() {
  const b = getBest();
  $('title-best').textContent = b > 0 ? `BEST: ${b.toLocaleString()} PTS` : '';
}
updateTitleBest();

/* ── Buttons ─────────────────────────────────────────────────────────────── */
$('btn-start').addEventListener('click', startGame);
$('btn-start').addEventListener('touchstart', e => { e.preventDefault(); startGame(); }, { passive: false });
$('btn-retry').addEventListener('click', startGame);
$('btn-retry').addEventListener('touchstart', e => { e.preventDefault(); startGame(); }, { passive: false });
$('btn-menu').addEventListener('click', () => showScreen('screen-title'));
$('btn-menu').addEventListener('touchstart', e => { e.preventDefault(); showScreen('screen-title'); }, { passive: false });

/* ── Start / Stop ─────────────────────────────────────────────────────────── */
function startGame() {
  initAudio(); resumeAudio();
  if (animId) cancelAnimationFrame(animId);
  G = freshState();
  resize();
  showScreen('screen-game');
  updateHUD();
  lastTs = performance.now();
  animId = requestAnimationFrame(loop);
}

function stopGame() {
  if (animId) { cancelAnimationFrame(animId); animId = null; }
}

/* ── Input ───────────────────────────────────────────────────────────────── */
function getPlantAt(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < NUM_PLANTS; i++) {
    const p = plantPositions[i];
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < p.r * 1.3 && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

canvas.addEventListener('click', e => {
  if (G?.phase !== 'playing') return;
  resumeAudio();
  const idx = getPlantAt(e.clientX, e.clientY);
  if (idx >= 0) tapPlant(idx);
});

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (G?.phase !== 'playing') return;
  resumeAudio();
  for (const touch of e.changedTouches) {
    const idx = getPlantAt(touch.clientX, touch.clientY);
    if (idx >= 0) tapPlant(idx);
  }
}, { passive: false });

// Keyboard: keys 1-6 map to plants
document.addEventListener('keydown', e => {
  if (G?.phase !== 'playing') return;
  const idx = parseInt(e.key) - 1;
  if (idx >= 0 && idx < NUM_PLANTS) tapPlant(idx);
  // Space = tap all active rings (accessibility)
  if (e.key === ' ') {
    e.preventDefault();
    for (let i = 0; i < NUM_PLANTS; i++) {
      if (G.plants[i].ringActive && !G.plants[i].tapped) tapPlant(i);
    }
  }
});

/* ═══════════════════════════════════════════════════════════════════════════════
   GAME LOOP
═══════════════════════════════════════════════════════════════════════════════ */
function loop(ts) {
  animId = requestAnimationFrame(loop);
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  if (!G || G.phase === 'dead') return;
  update(dt, ts);
  draw(ts);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UPDATE
═══════════════════════════════════════════════════════════════════════════════ */
function update(dt, ts) {
  G.beatClock += dt;
  G.bgPulse = Math.max(0, G.bgPulse - dt * 4);
  G.screenShake = Math.max(0, G.screenShake - dt * 8);

  // ── Beat tick ──
  if (G.beatClock >= G.beatInterval) {
    G.beatClock -= G.beatInterval;
    G.beatCount++;
    onBeat();
  }

  // Interpolated ring position
  for (const plant of G.plants) {
    tickPlant(plant, dt, ts);
  }

  // Particles
  tickParticles(dt);

  // Level up — BPM ramp
  const newLevel = 1 + Math.floor(G.score / 500);
  if (newLevel > G.level) {
    G.level = newLevel;
    G.bpm = Math.min(160, 90 + (G.level - 1) * 8);
    G.beatInterval = 60 / G.bpm;
    $('hud-level').textContent = `LV ${G.level}`;
  }

  updateHUD();
}

function onBeat() {
  resumeAudio();
  const now = audioCtx ? audioCtx.currentTime : 0;

  // Kick on beats 1 & 3 (4/4 time)
  if (G.beatCount % 4 === 0 || G.beatCount % 4 === 2) playKick(now);
  // Hi-hat on every beat, open on 2 & 4
  playHat(now, G.beatCount % 4 === 1 || G.beatCount % 4 === 3);

  // Beat ring flash
  G.beatFlash = 0.18;
  G.bgPulse   = 1;

  const beatRingEl = $('beat-ring');
  beatRingEl.classList.remove('pulse');
  void beatRingEl.offsetWidth;
  beatRingEl.classList.add('pulse');
  setTimeout(() => beatRingEl.classList.remove('pulse'), 180);

  // Activate rings for plants whose pattern fires this beat
  for (const plant of G.plants) {
    plant.nextBeatIn--;
    if (plant.nextBeatIn <= 0) {
      // Schedule next
      plant.nextBeatIn = plant.pattern[plant.beatPhase % plant.pattern.length];
      plant.beatPhase++;

      if (plant.stage !== 4) { // not wilted
        activateRing(plant);
      }
    }
  }
}

function activateRing(plant) {
  // Ring lives for beatInterval * pattern[0] * 0.8 — shrinks to zero, then auto-miss
  plant.ringActive   = true;
  plant.ringRadius   = 1.0;
  plant.tapped       = false;
  plant.ringDuration = G.beatInterval * 0.85;
}

function tickPlant(plant, dt, ts) {
  // Idle bob
  plant.bobOffset += dt * 1.8;

  // Wobble after tap
  if (plant.wobble > 0) plant.wobble = Math.max(0, plant.wobble - dt * 6);

  // Hit result flash
  if (plant.hitTimer > 0) plant.hitTimer = Math.max(0, plant.hitTimer - dt * 3);

  // Wilt animation
  if (plant.wiltTimer > 0) plant.wiltTimer = Math.max(0, plant.wiltTimer - dt * 1.5);

  // Grow animation
  if (plant.growTimer > 0) plant.growTimer = Math.max(0, plant.growTimer - dt * 2.5);

  // Ring shrink
  if (plant.ringActive && !plant.tapped) {
    plant.ringRadius -= dt / plant.ringDuration;
    if (plant.ringRadius <= 0) {
      // AUTO-MISS
      plant.ringActive = false;
      plant.ringRadius = 0;
      handleMiss(plant);
    }
  } else if (plant.tapped) {
    // Fade out tapped ring quickly
    plant.ringRadius = Math.max(0, plant.ringRadius - dt * 8);
    if (plant.ringRadius <= 0) plant.ringActive = false;
  }
}

/* ── Tap handling ────────────────────────────────────────────────────────── */
function tapPlant(idx) {
  const plant = G.plants[idx];
  if (!plant.ringActive || plant.tapped) return;

  // How close to perfect? ringRadius of ~0.05 is the bullseye
  const closeness = plant.ringRadius; // 0=perfect, 1=too early
  const now = audioCtx ? audioCtx.currentTime : 0;

  plant.tapped    = true;
  plant.wobble    = 1;
  plant.ringRadius = Math.max(0, plant.ringRadius - 0.15); // snap ring inward a bit

  if (closeness <= WINDOW_PERFECT) {
    handlePerfect(plant, now);
  } else if (closeness <= WINDOW_GOOD) {
    handleGood(plant, now);
  } else {
    handleMiss(plant);
  }
}

function handlePerfect(plant, now) {
  const mult = COMBO_MULT[Math.min(G.combo, COMBO_MULT.length - 1)];
  const pts  = Math.round(PTS_PERFECT * mult);
  G.score   += pts;
  G.combo++;
  G.maxCombo = Math.max(G.maxCombo, G.combo);
  G.totalPerfect++;

  plant.hitResult = 'perfect';
  plant.hitTimer  = 1;
  if (plant.stage < 3) { plant.stage++; plant.growTimer = 1; }

  showFeedback('PERFECT!', plant.idx, '#4dffa0');
  playTone(now, PLANT_FREQS[plant.idx]);
  spawnParticles(plant.idx, '#4dffa0', 12);
  bumpScore();
}

function handleGood(plant, now) {
  const mult = COMBO_MULT[Math.min(G.combo, COMBO_MULT.length - 1)];
  const pts  = Math.round(PTS_GOOD * mult);
  G.score   += pts;
  G.combo++;
  G.maxCombo = Math.max(G.maxCombo, G.combo);
  G.totalGood++;

  plant.hitResult = 'good';
  plant.hitTimer  = 1;

  showFeedback('GOOD', plant.idx, '#ffd93d');
  playTone(now, PLANT_FREQS[plant.idx], 0.18);
  spawnParticles(plant.idx, '#ffd93d', 6);
  bumpScore();
}

function handleMiss(plant) {
  G.combo = 0;
  G.totalMiss++;
  G.screenShake = 1;

  plant.hitResult = 'miss';
  plant.hitTimer  = 1;
  plant.ringActive = false;

  // Plant wilts
  if (plant.stage > 1) {
    plant.stage    = 4;
    plant.wiltTimer = 1;
  } else {
    plant.stage = 4;
    plant.wiltTimer = 1;
  }

  // Lose a life
  G.lives--;
  updateHUD();
  showFeedback('MISS', plant.idx, '#ff6b9d');
  shakeScreen();

  // Revive the plant after a delay (it regrows)
  setTimeout(() => {
    if (!G || G.phase !== 'playing') return;
    plant.stage    = 1;
    plant.growTimer = 1;
    plant.hitResult = null;
  }, G.beatInterval * 4 * 1000);

  if (G.lives <= 0) {
    setTimeout(() => gameOver(), 600);
  }
}

/* ── HUD ─────────────────────────────────────────────────────────────────── */
function updateHUD() {
  if (!G) return;
  $('hud-score').textContent = G.score.toLocaleString();
  const lives = ['', '🌸', '🌸🌸', '🌸🌸🌸'][G.lives] || '';
  $('hud-lives').textContent = lives;
  const comboEl = $('hud-combo');
  if (G.combo >= 3) {
    comboEl.textContent = `×${G.combo} COMBO`;
  } else {
    comboEl.textContent = '';
  }
}

function bumpScore() {
  const el = $('hud-score');
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

/* ── Feedback text ───────────────────────────────────────────────────────── */
function showFeedback(text, plantIdx, color) {
  const pos = plantPositions[plantIdx];
  if (!pos) return;
  const rect = canvas.getBoundingClientRect();
  const el   = document.createElement('div');
  el.className = 'fb-text';
  el.textContent = text;
  el.style.color = color;
  el.style.left  = (rect.left + pos.x) + 'px';
  el.style.top   = (rect.top + pos.y - pos.r * 0.6 + HH) + 'px';
  feedbackLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function shakeScreen() {
  document.getElementById('screen-game').classList.remove('shaking');
  void document.getElementById('screen-game').offsetWidth;
  document.getElementById('screen-game').classList.add('shaking');
}

/* ── Particles ───────────────────────────────────────────────────────────── */
function spawnParticles(plantIdx, color, n) {
  const pos = plantPositions[plantIdx];
  if (!pos) return;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    const speed = 50 + Math.random() * 80;
    G.particles.push({
      x: pos.x, y: pos.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      r: 4 + Math.random() * 5,
      color: Math.random() < 0.3 ? '#ffffff' : color,
      life: 0.5 + Math.random() * 0.35,
      maxLife: 0.85,
      shape: Math.random() < 0.4 ? 'star' : 'circle',
    });
  }
}

function tickParticles(dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.life -= dt;
    if (p.life <= 0) { G.particles.splice(i, 1); continue; }
    p.x  += p.vx * dt;
    p.y  += p.vy * dt;
    p.vy += 180 * dt; // gravity
  }
}

/* ── Game over ───────────────────────────────────────────────────────────── */
function gameOver() {
  if (!G || G.phase === 'dead') return;
  G.phase = 'dead';
  stopGame();
  saveBest(G.score);
  updateTitleBest();

  $('over-score').textContent  = G.score.toLocaleString();
  const best = getBest();
  $('over-best').textContent   = G.score >= best ? '🌟 NEW BEST!' : `BEST: ${best.toLocaleString()}`;
  $('over-emoji').textContent  = G.score > 1000 ? '🌺' : G.score > 400 ? '🌷' : '🥀';
  $('over-stats').innerHTML = [
    { v: G.maxCombo,     l: 'MAX COMBO' },
    { v: G.totalPerfect, l: 'PERFECT'   },
    { v: G.level,        l: 'LEVEL'     },
  ].map(s => `<div class="os-box"><div class="os-val">${s.v}</div><div class="os-lbl">${s.l}</div></div>`).join('');

  showScreen('screen-over');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   DRAW
═══════════════════════════════════════════════════════════════════════════════ */
function draw(ts) {
  const W = canvas.width, H = canvas.height;

  // Background — lush garden green with subtle pulse
  const pulse = G.bgPulse * 0.06;
  ctx.fillStyle = `rgb(${Math.round(45 + pulse * 255 * 0.15)},${Math.round(90 + pulse * 255 * 0.1)},${Math.round(39)})`;
  ctx.fillRect(0, 0, W, H);

  // Grid dividers (soft)
  ctx.strokeStyle = 'rgba(255,255,255,.05)';
  ctx.lineWidth   = 1;
  for (let c = 1; c < COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * W/COLS, 0); ctx.lineTo(c * W/COLS, H); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, H/2); ctx.lineTo(W, H/2); ctx.stroke();

  // Ground strip per cell
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const idx = row * COLS + col;
      const pos = plantPositions[idx];
      const r   = pos.r;
      const groundY = pos.y + r * 0.55;
      // Soil patch
      const grad = ctx.createRadialGradient(pos.x, groundY, 0, pos.x, groundY, r * 0.9);
      grad.addColorStop(0, 'rgba(101,67,33,.45)');
      grad.addColorStop(1, 'rgba(101,67,33,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(pos.x, groundY, r * 0.85, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Plants
  for (const plant of G.plants) {
    drawPlant(plant, ts);
  }

  // Particles
  drawParticles();
}

/* ── Draw one plant cell ─────────────────────────────────────────────────── */
function drawPlant(plant, ts) {
  const pos  = plantPositions[plant.idx];
  if (!pos) return;
  const { x, y, r } = pos;
  const type = plant.type;

  // Cell hover glow when ring is active
  if (plant.ringActive && !plant.tapped) {
    const alpha = 0.08 + Math.sin(ts / 200) * 0.04;
    ctx.fillStyle = type.col + Math.round(alpha * 255).toString(16).padStart(2,'0');
    ctx.fillRect(pos.x - pos.colW/2, pos.y - pos.rowH/2, pos.colW, pos.rowH);
  }

  // Bob animation
  const bob = Math.sin(plant.bobOffset) * 3;
  const wobbleAngle = Math.sin(plant.wobble * Math.PI * 4) * plant.wobble * 0.18;

  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(wobbleAngle);

  const s = plant.stage; // 1=seed, 2=sprout, 3=bloom, 4=wilt
  const growScale = s === 1 ? 0.5 + (1 - plant.growTimer) * 0.5 : 1.0;

  // Wilt droop
  if (s === 4) {
    const wilt = plant.wiltTimer;
    ctx.rotate(wilt * 0.4 + (1 - plant.wiltTimer) * 0.6);
    ctx.globalAlpha = 0.5 + plant.wiltTimer * 0.5;
  }

  ctx.scale(growScale, growScale);

  const pr = r * 0.55; // plant visual radius

  // ── Stem ──
  if (s >= 2) {
    const stemH = s === 3 ? pr * 0.75 : pr * 0.5;
    ctx.strokeStyle = s === 4 ? '#556b44' : '#5a9e40';
    ctx.lineWidth   = r * 0.1;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(0, pr * 0.35);
    ctx.quadraticCurveTo(pr * 0.15, 0, 0, -stemH * 0.6);
    ctx.stroke();

    // Leaves
    if (s >= 2) {
      drawLeaf(ctx, pr * 0.2, -stemH * 0.1, pr * 0.28, -0.5, s === 4 ? '#4a6e30' : '#4a8c3f');
      if (s >= 3)
        drawLeaf(ctx, -pr * 0.2, -stemH * 0.3, pr * 0.22, 0.5, s === 4 ? '#4a6e30' : '#5aaa4f');
    }
  }

  // ── Flower head ──
  const headY = s >= 2 ? -pr * (s === 3 ? 0.85 : 0.6) : 0;
  const headR = s === 1 ? pr * 0.28 : s === 2 ? pr * 0.35 : pr * 0.5;
  const col   = s === 4 ? '#887766' : type.col;
  const col2  = s === 4 ? '#665544' : type.col2;

  if (type.shape === 'round' || type.shape === 'puff') {
    drawPetals(ctx, 0, headY, headR, type.petals, col, col2, ts + plant.idx * 200);
  } else if (type.shape === 'star') {
    drawStar(ctx, 0, headY, headR, type.petals, col, col2);
  } else if (type.shape === 'cup') {
    drawCup(ctx, 0, headY, headR, col, col2);
  } else if (type.shape === 'bell') {
    drawBell(ctx, 0, headY, headR, col, col2);
  } else if (type.shape === 'leaf') {
    drawBigLeaf(ctx, 0, headY, headR, col, col2);
  }

  // Seed (stage 1)
  if (s === 1) {
    ctx.fillStyle = '#8b5e3c';
    ctx.beginPath(); ctx.ellipse(0, 0, headR * 0.7, headR, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a06b3d';
    ctx.beginPath(); ctx.ellipse(-headR * 0.15, -headR * 0.2, headR * 0.25, headR * 0.3, 0.2, 0, Math.PI * 2); ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.restore();

  // ── Hit result flash ──
  if (plant.hitTimer > 0 && plant.hitResult) {
    const a = plant.hitTimer * 0.4;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = plant.hitResult === 'perfect' ? '#4dffa0'
                  : plant.hitResult === 'good'    ? '#ffd93d' : '#ff6b9d';
    ctx.beginPath(); ctx.arc(x, y + bob, r * 0.85, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Timing ring ──
  if (plant.ringActive) {
    const rr = plant.ringRadius;
    const ringR = r * (0.35 + rr * 0.65); // ring shrinks from outer edge to center
    const alpha = 0.5 + rr * 0.5;
    const ringCol = rr <= WINDOW_PERFECT ? '#4dffa0'
                  : rr <= WINDOW_GOOD    ? '#ffd93d' : type.col;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = ringCol;
    ctx.lineWidth   = Math.max(2, r * 0.06 * (1 + rr));
    ctx.beginPath();
    ctx.arc(x, y + bob, ringR, 0, Math.PI * 2);
    ctx.stroke();
    // Inner glow when near perfect
    if (rr <= WINDOW_PERFECT + 0.05) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = r * 0.04;
      ctx.globalAlpha = (1 - rr / (WINDOW_PERFECT + 0.05)) * 0.8;
      ctx.beginPath();
      ctx.arc(x, y + bob, ringR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ── Plant name label (tiny, at bottom of cell) ──
  ctx.save();
  ctx.font = `700 ${Math.round(r * 0.2)}px 'Nunito', sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.fillText(type.name, x, y + pos.rowH / 2 - 8);
  ctx.restore();
}

/* ── Plant shape helpers ─────────────────────────────────────────────────── */
function drawPetals(ctx, x, y, r, n, col, col2, tseed) {
  // Centre
  ctx.save();
  ctx.translate(x, y);
  // Petals
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 + tseed * 0.0003;
    const px = Math.cos(angle) * r * 0.62;
    const py = Math.sin(angle) * r * 0.62;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(px, py, r * 0.38, r * 0.28, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  // Centre disc
  ctx.fillStyle = col2;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fffde7';
  ctx.beginPath(); ctx.arc(-r * 0.06, -r * 0.06, r * 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawStar(ctx, x, y, r, points, col, col2) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = col;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const len   = i % 2 === 0 ? r : r * 0.45;
    if (i === 0) ctx.moveTo(Math.cos(angle) * len, Math.sin(angle) * len);
    else ctx.lineTo(Math.cos(angle) * len, Math.sin(angle) * len);
  }
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = col2;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.28, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCup(ctx, x, y, r, col, col2) {
  ctx.save(); ctx.translate(x, y);
  // Rose cup shape — 5 overlapping rounded petals
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 - Math.PI / 2;
    ctx.fillStyle = i % 2 === 0 ? col : col2;
    ctx.beginPath();
    ctx.ellipse(Math.cos(angle) * r * 0.45, Math.sin(angle) * r * 0.45, r * 0.42, r * 0.55, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = col2;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBell(ctx, x, y, r, col, col2) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.bezierCurveTo(r * 0.8, -r * 0.8, r, 0, r * 0.6, r * 0.5);
  ctx.lineTo(-r * 0.6, r * 0.5);
  ctx.bezierCurveTo(-r, 0, -r * 0.8, -r * 0.8, 0, -r);
  ctx.fill();
  ctx.fillStyle = col2;
  ctx.beginPath(); ctx.ellipse(0, r * 0.35, r * 0.5, r * 0.22, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBigLeaf(ctx, x, y, r, col, col2) {
  ctx.save(); ctx.translate(x, y);
  // Triple-leaf clover shape
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 - Math.PI / 2;
    ctx.fillStyle = i === 1 ? col2 : col;
    ctx.beginPath();
    ctx.ellipse(Math.cos(angle) * r * 0.4, Math.sin(angle) * r * 0.4, r * 0.42, r * 0.3, angle, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawLeaf(ctx, x, y, r, angle, col) {
  ctx.save();
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.5, angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ── Draw particles ──────────────────────────────────────────────────────── */
function drawParticles() {
  for (const p of G.particles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle   = p.color;
    if (p.shape === 'star') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.life * 8);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const ang = (i / 8) * Math.PI * 2;
        const len = i % 2 === 0 ? p.r : p.r * 0.5;
        if (i === 0) ctx.moveTo(Math.cos(ang)*len, Math.sin(ang)*len);
        else ctx.lineTo(Math.cos(ang)*len, Math.sin(ang)*len);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.r * a), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ── Title screen art ────────────────────────────────────────────────────── */
window.addEventListener('load', () => {
  updateTitleBest();
});
