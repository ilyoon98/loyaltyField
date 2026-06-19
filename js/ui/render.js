// ── UI 렌더 primitive (화면전환 / 3구역 연출 / VFX / SFX / 로그) ──
// 앱 함수는 호출하지 않는 리프 모듈 (DOM + S + 데이터만). render()/renderHand()는
// 입력 핸들러를 참조하므로 input 모듈에 둔다.
import { S } from '../core/store.js';
import { CHARACTERS, charImgHtml } from '../data/characters.js';

// ── 화면 전환 ────────────────────────────────────────────────
export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

// ── 로컬 캐릭터 선택 그리드 ───────────────────────────────────
export function renderLocalCharSelect() {
  const grid = document.getElementById('charGrid');
  grid.innerHTML = '';
  CHARACTERS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'char-card';
    div.innerHTML = `${charImgHtml(c)}<div class="nm">${c.id}</div><div class="ef">${c.desc}</div>`;
    div.onclick = () => {
      S.selectedChar = c.id;
      document.querySelectorAll('#charGrid .char-card').forEach(e => e.classList.remove('sel'));
      div.classList.add('sel');
      document.getElementById('startBtn').disabled = false;
    };
    grid.appendChild(div);
  });
}

export function setStatus(t) { document.getElementById('statusBar').textContent = t; }

// ── 3구역 연출 레이어 (기획 12-5 v7) ─────────────────────────
export function setZone(zoneId, html, cls) {
  const el = document.getElementById(zoneId);
  if (!el) return;
  el.className = 'stage-zone' + (cls ? ' zone-' + cls : '');
  el.innerHTML = html
    ? `<div class="zone-inner${cls ? ' c-' + cls : ''}">${html}</div>`
    : '';
}
export function showStageLeft(html, cls)   { setZone('stageLeft',   html, cls); }
export function showStageCenter(html, cls) { setZone('stageCenter', html, cls); }
export function showStageRight(html, cls)  { setZone('stageRight',  html, cls); }

export function clearCenterRight() {
  setZone('stageCenter', '', '');
  setZone('stageRight',  '', '');
}
export function clearAllZones() {
  setZone('stageLeft',   '', '');
  setZone('stageCenter', '', '');
  setZone('stageRight',  '', '');
}
export function clearStage() { clearAllZones(); }

// 플레이어 카드 위로 데미지/회복 숫자가 튀어오름
export function floatNumber(targetId, amount, isHeal) {
  const card = document.getElementById('pl-' + targetId);
  if (!card) return;
  const span = document.createElement('div');
  span.className = 'dmg-float' + (isHeal ? ' heal-float' : '');
  span.textContent = (isHeal ? '+' : '−') + amount;
  card.appendChild(span);
  setTimeout(() => span.remove(), 1000);
}

// ── 이벤트 VFX (데미지=원 퍼짐 / 회복=스파클 상승 / 방어=번쩍) ──
// el에 오버레이 자식을 붙이고 애니메이션 후 제거. el은 position:relative여야 함.
export function vfxBurst(el, type) {
  if (!el) return;
  if (type === 'dmg') {
    const r = document.createElement('div'); r.className = 'vfx vfx-dmg';
    el.appendChild(r); setTimeout(() => r.remove(), 600);
  } else if (type === 'heal') {
    for (let i = 0; i < 6; i++) {
      const s = document.createElement('div'); s.className = 'vfx vfx-heal';
      s.style.left = (18 + Math.random() * 64) + '%';
      s.style.animationDelay = (Math.random() * 0.25) + 's';
      el.appendChild(s); setTimeout(() => s.remove(), 1200);
    }
  } else if (type === 'block') {
    const f = document.createElement('div'); f.className = 'vfx vfx-flash';
    el.appendChild(f); setTimeout(() => f.remove(), 400);
  }
}
export function vfxAt(targetId, zoneId, type) {
  vfxBurst(document.getElementById('pl-' + targetId), type);   // 캐릭터 카드
  if (zoneId) vfxBurst(document.getElementById(zoneId), type); // 스테이지 존(결과 카드)
}

// ── SFX (WebAudio 합성 — 에셋 파일 없음) ──────────────────────
export function ensureAudio() {
  try {
    if (!S.audioCtx) S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (S.audioCtx.state === 'suspended') S.audioCtx.resume();
  } catch (e) { S.audioCtx = null; }
}
export function tone(type, freq0, freq1, dur, vol, when) {
  const o = S.audioCtx.createOscillator(), g = S.audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq0, when);
  if (freq1 !== freq0) o.frequency.exponentialRampToValueAtTime(freq1, when + dur);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(vol, when + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
  o.connect(g).connect(S.audioCtx.destination);
  o.start(when); o.stop(when + dur + 0.02);
}
export function playSFX(type) {
  ensureAudio(); if (!S.audioCtx) return;
  const t = S.audioCtx.currentTime;
  if (type === 'dmg')        tone('square',   190, 60, 0.20, 0.22, t);
  else if (type === 'heal')  { tone('sine', 523, 523, 0.30, 0.18, t); tone('sine', 784, 784, 0.30, 0.16, t + 0.09); }
  else if (type === 'block') tone('triangle', 900, 1500, 0.18, 0.20, t);
}

// ── 로그 ──────────────────────────────────────────────────────
export function pushLog(msg, kind) {
  // 온라인 재생 중: 모든 클라가 동일 큐를 재생하므로 DOM에만 찍고 DB엔 안 올림
  if (S.onlineLocalLogOnly) { appendLog(msg, kind); return; }
  if (!S.state) return;
  S.state.log.push(msg);
  appendLog(msg, kind);
}
export function appendLog(msg, kind) {
  const box = document.getElementById('logBox');
  const line = document.createElement('div');
  line.className = 'l-' + (kind||'sys');
  line.textContent = '▸ ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
