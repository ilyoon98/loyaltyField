
/* =============================================================
   으리챗 난투전 v0.4 — 로컬 AI + 온라인 멀티 (Firebase)
   ============================================================= */

// ── 모듈 import (entry: 모드선택·치트·배선·init) ──────────────
import { db, FB_READY } from './core/firebase.js';
import { CARD_DEFS, CARD_KEYS, cardIcon } from './data/cards.js';
import { effValue } from './data/characters.js';
import { toArr } from './util.js';
import { S, myPlayerId } from './core/store.js';
import { showScreen, renderLocalCharSelect, ensureAudio } from './ui/render.js';
import { render, reactionConfirm, reactionTake, passAction } from './ui/input.js';
import { startLocalGame } from './engine.js';
import { createRoom, joinRoom, copyRoomCode, startOnlineGame, playAgain, leaveRoomAndReload, updateJoinBtn, tryRejoinOnline } from './online.js';

// ── 런타임 상태 ───────────────────────────────────────────────

// ── 모드 선택 ────────────────────────────────────────────────
function startLocalMode() {
  S.gameMode = 'local';
  S.selectedChar = null;
  document.getElementById('startBtn').disabled = true;
  renderLocalCharSelect();
  showScreen('select');
}

function goOnline() {
  if (!FB_READY) {
    alert('Firebase 설정이 필요합니다.\nindex.html 상단의 FIREBASE_CONFIG 값을 채워주세요.');
    return;
  }
  document.getElementById('lobbyError').textContent = '';
  showScreen('online');
}

document.getElementById('startBtn').onclick = startLocalGame;

// ── 피격 반응(레거시 모달, 미사용) ───────────────────────────
function closeReactModal() { document.getElementById('reactOverlay').classList.remove('active'); }

// ── 데미지 적용 ───────────────────────────────────────────────

// ── 이벤트 큐 + 재생기 (기획 12장) ────────────────────────────

// ── 큐 재생 중 공격자/피격자 강조 ──────────────────────────────

// 단일 ATK 한 건 → 이벤트 배열 (계산만, 실제 적용은 재생기에서 박자별로)

// 전체공격(ALL) → 대상별 단계 이벤트 (기획 12-3: 대상마다 명중판정 + 방어 기회)
// 한꺼번에 처리하지 않고 대상 하나씩 꺼내 hitcheck→askDefense(DEF/맞기만)→damage.

// 피격자 응답 → 후속 이벤트(연출+데미지). 반응 카드 소모는 이 시점에 처리. (v8: 연쇄 허용)

// 피격자에게 방어/반사/바운스/맞기 입력 요청 → choice 반환 (Promise)

// ── 손패 직접 반응 (팝업 대신 손패에서 카드 클릭) ──────────────
// withCountdown: 온라인 응답에만 카운트다운(코스메틱). resolve는 choice 계약 그대로.

// 손패 카드 클릭(반응 모드). DEF=누적 토글, REFLECT/Bounce=즉시 확정(방어와 혼용 불가).

// 내 입력 없이 상황 종료(온라인: owner 타임아웃/취소로 await 해제) → UI만 닫음(resolve 안 함)

// 큐 전용 방어 모달 — 3-모드 탭 UI (v8: 방어 누적, 연쇄, ALL 반사 허용)
function openDefenseModal(attackerId, targetId, atkKey, dmg, reactions, resolve) {
  const tChar = S.state.players[targetId].characterId;
  document.getElementById('reactDesc').textContent =
    `${S.state.players[attackerId].name}의 ${CARD_DEFS[atkKey]?.name || '공격'} — ${dmg} 데미지!`;
  const box = document.getElementById('reactCards');
  box.innerHTML = '';
  const pick = (choice) => { closeReactModal(); resolve(choice); };

  const defCards   = reactions.filter(o => CARD_DEFS[o.k]?.type === 'DEF');
  const reactCards = reactions.filter(o => CARD_DEFS[o.k]?.type !== 'DEF');
  let selectedDefKeys = [];   // 다중 선택된 방어 카드 key 배열

  // ── 탭 행 ──
  const tabs = document.createElement('div');
  tabs.className = 'def-tabs';

  function makeTab(label, onclick) {
    const t = document.createElement('button');
    t.className = 'def-tab'; t.textContent = label; t.onclick = onclick;
    tabs.appendChild(t); return t;
  }

  const content = document.createElement('div');

  function setMode(mode, activeTab) {
    tabs.querySelectorAll('.def-tab').forEach(t => t.classList.remove('active'));
    activeTab.classList.add('active');
    selectedDefKeys = [];
    content.innerHTML = '';

    if (mode === 'def') {
      defCards.forEach(o => {
        const val = effValue(o.k, tChar);
        const btn = document.createElement('div');
        btn.className = 'react-opt';
        btn.innerHTML = `<b>${CARD_DEFS[o.k].name}</b> — 방어 ${val}`;
        btn.onclick = () => {
          const i = selectedDefKeys.indexOf(o.k);
          if (i >= 0) { selectedDefKeys.splice(i, 1); btn.classList.remove('selected'); }
          else         { selectedDefKeys.push(o.k);    btn.classList.add('selected'); }
          updateSummary();
        };
        content.appendChild(btn);
      });
      const summary = document.createElement('div');
      summary.className = 'def-summary'; summary.id = 'defSummary';
      content.appendChild(summary);
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'def-confirm';
      confirmBtn.textContent = '완료';
      confirmBtn.onclick = () => {
        pick(selectedDefKeys.length === 0 ? 'take' : { defCards: selectedDefKeys });
      };
      content.appendChild(confirmBtn);
      updateSummary();

    } else if (mode === 'react') {
      reactCards.forEach(o => {
        const d = CARD_DEFS[o.k];
        const btn = document.createElement('div');
        btn.className = 'react-opt';
        btn.innerHTML = `<b>${d.name}</b> — `
          + (d.type === 'REFLECT' ? '공격자에게 그대로 반사' : '랜덤 대상에게 떠넘김');
        btn.onclick = () => pick(o);
        content.appendChild(btn);
      });
    }
  }

  function updateSummary() {
    const el = document.getElementById('defSummary'); if (!el) return;
    const total = selectedDefKeys.reduce((s,k) => s + effValue(k, tChar), 0);
    el.textContent = total > 0
      ? `합산 방어: −${total} / 남은 데미지: ${Math.max(0, dmg - total)}`
      : '카드를 선택하세요 (선택 없이 완료 = 그냥 맞기)';
  }

  if (defCards.length > 0)   { const t = makeTab('🛡 방어', () => setMode('def', t));   }
  if (reactCards.length > 0) { const t = makeTab('🔄 반사/튕기기', () => setMode('react', t)); }
  const takeT = makeTab('😣 그냥 맞기', () => pick('take'));

  box.appendChild(tabs);
  box.appendChild(content);

  // 기본 모드: 방어 카드 있으면 방어, 없으면 맞기 탭 강조
  if (defCards.length > 0) {
    setMode('def', tabs.querySelector('.def-tab'));
  } else if (reactCards.length > 0) {
    setMode('react', tabs.querySelectorAll('.def-tab')[0]);
  } else {
    takeT.classList.add('active');
  }

  document.getElementById('reactOverlay').classList.add('active');
}

// 비-askDefense 이벤트의 시각/상태 처리 (로컬·온라인 공유). askDefense는 호출자가 처리.
// counterAnnounce/damage 등에서 q를 splice할 수 있으므로 (q, i)를 받는다.
// 과거의 `continue`는 여기서 `return`(이 이벤트 처리 종료)으로 대응 — 호출 루프가 i++ 한다.

// 재생기(로컬): 큐를 한 박자씩 소비 (기획 12장 v8)

// ── AI 턴 ─────────────────────────────────────────────────────

// ── 승리 체크 ────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
// 온라인 액션(큐) — 기획 12-1. owner(현재 AP)가 큐를 만들고 랜덤을 baking,
// DB에 올리면 모든 클라가 동일 재생. askDefense에서 피격자 입력을 DB로 주고받음.
// Stage 3: 단일 ATK / HEAL / ALL, 반응은 방어/반사/튕기기(연쇄)/맞기 전부 지원.
// ══════════════════════════════════════════════════════════════

// 회복 카드. 대상(자신 포함)을 healTarget로 받음. 회복량 보너스는 시전자 캐릭터 기준.

// owner 진입점: 카드 확정 후 호출. 트랜잭션 가드로 "내가 진짜 AP인지" 원자적 확인 후 큐 업로드.

// 트랜잭션: 읽기-검증-쓰기 원자화. 내가 현재 AP가 아니거나 진행 중 액션 있으면 abort.

// owner: askDefense에서 await 게시 후 input 기다림
// owner 전용. timeoutMs 경과 시 자동 'take'(맞기)로 resolve → 게임 멈춤 방지(기획 6장).

// spectator: owner가 큐에 반응 이벤트를 splice하고 resolved 표시할 때까지 대기 → 갱신된 큐 반환.
// action.done===true(=owner 이탈로 취소)면 'ABORT' 반환 → 재생 루프 탈출.

// owner: 반응 이벤트 splice 후 큐 업로드 (resolved 플래그 포함), await/input 클리어

// spectator(피격자): 모달 선택 결과를 input으로 기록 (트랜잭션 가드)

// 상설 리스너: action/await를 감시해 내가 응답자(target)면 모달 표시.
// 재생 루프와 분리 → owner가 target이어도(반사 역전 등) deadlock 없이 모달이 뜬다.

// 온라인 재생기: 모든 클라가 동일 큐 재생. askDefense만 transport 분기.

// owner 권위 정산 (Stage 1~3): 손패 보충·턴 넘김·승패를 한 번의 update로 확정.
// 모든 클라는 이 DB값(currentTurnIndex/phase)만 보고 자기 턴 여부를 판정한다.

// 온라인 패스: 트랜잭션으로 AP 검증 + 드로우 + 턴 넘김

// ── 렌더링 ───────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
// 치트 패널 (테스트 전용) — 본 게임 로직 미변경, 값 주입만.
// 온라인은 DB에 써서 양쪽 동기화(Stage 1~2 원칙). 재생 중엔 사용 금지.
// ══════════════════════════════════════════════════════════════

function revealCheat() {
  S.cheatVisible = !S.cheatVisible;
  document.getElementById('cheatBtn').style.display = S.cheatVisible ? 'block' : 'none';
  if (!S.cheatVisible) {
    document.getElementById('cheatPanel').style.display = 'none';
  }
}

// 활성화 1: Ctrl+Shift+D
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
    e.preventDefault(); revealCheat();
  }
});
// 활성화 2: 제목 5연타
document.querySelector('header h1').addEventListener('click', () => {
  S.titleClicks++;
  clearTimeout(S.titleClickTimer);
  S.titleClickTimer = setTimeout(() => { S.titleClicks = 0; }, 1500);
  if (S.titleClicks >= 5) { S.titleClicks = 0; revealCheat(); }
});

function toggleCheatPanel() {
  const panel = document.getElementById('cheatPanel');
  const open = panel.style.display !== 'block';
  if (open) refreshCheatPanel();
  panel.style.display = open ? 'block' : 'none';
}

function cheatMsg(t) {
  const el = document.getElementById('cheatMsg');
  el.textContent = t;
  setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 2500);
}

// 패널 열 때 카드/플레이어 목록 채우기
function refreshCheatPanel() {
  const cardSel = document.getElementById('cheatCardSel');
  cardSel.innerHTML = '';
  CARD_KEYS.forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = `${cardIcon(k)} ${CARD_DEFS[k].name} (${CARD_DEFS[k].type})`;
    cardSel.appendChild(o);
  });
  const plSel = document.getElementById('cheatPlayerSel');
  plSel.innerHTML = '';
  if (S.state && S.state.turnOrder) {
    S.state.turnOrder.forEach(id => {
      const p = S.state.players[id]; if (!p) return;
      const o = document.createElement('option');
      o.value = id; o.textContent = `${p.name} (HP ${p.hp}${p.alive ? '' : ' 💀'})`;
      plSel.appendChild(o);
    });
  }
}

// 온라인에서 재생 중이면 치트 금지 (desync 방지)
function cheatGuard() {
  if (!S.state) { cheatMsg('게임 중에만 사용 가능'); return false; }
  if (S.gameMode === 'online' && S.onlineReplaying) { cheatMsg('재생 중에는 사용 불가'); return false; }
  return true;
}

function cheatAddCard() {
  if (!cheatGuard()) return;
  const key = document.getElementById('cheatCardSel').value;
  const myId = myPlayerId();
  const me = S.state.players[myId];
  if (!me) { cheatMsg('내 플레이어 없음'); return; }
  if (S.gameMode === 'online') {
    // DB 권위 write → 리스너가 양쪽 동기화
    db.ref('rooms/' + S.roomId + '/players/' + myId + '/hand').transaction(h => {
      const arr = toArr(h); arr.push(key); return arr;
    });
  } else {
    me.hand = toArr(me.hand); me.hand.push(key); render();
  }
  cheatMsg(`${CARD_DEFS[key].name} 추가됨`);
}

function cheatSetHp() {
  if (!cheatGuard()) return;
  const id = document.getElementById('cheatPlayerSel').value;
  const hp = parseInt(document.getElementById('cheatHpInput').value, 10);
  if (isNaN(hp) || hp < 0) { cheatMsg('유효한 HP 값 입력'); return; }
  if (!S.state.players[id]) { cheatMsg('플레이어 없음'); return; }
  const alive = hp > 0;
  if (S.gameMode === 'online') {
    db.ref('rooms/' + S.roomId + '/players/' + id).update({ hp, alive });
  } else {
    S.state.players[id].hp = hp; S.state.players[id].alive = alive; render();
  }
  cheatMsg(`${S.state.players[id].name} HP=${hp}`);
  refreshCheatPanel();
}

// ── 초기화 ───────────────────────────────────────────────────
if (!FB_READY) {
  document.getElementById('onlineModeCard').style.opacity = '0.5';
  document.getElementById('onlineModeCard').title = 'Firebase 설정 필요';
}
renderLocalCharSelect();
tryRejoinOnline();   // 새로고침 시 진행 중이던 온라인 방으로 복귀 (Stage 5b)

// ── 전역 클릭 이펙트 (순수 비주얼) ────────────────────────────
function spawnClickFx(x, y) {
  const fx = document.createElement('div');
  fx.className = 'click-fx';
  fx.style.left = x + 'px';
  fx.style.top  = y + 'px';
  const ring = document.createElement('div');
  ring.className = 'ring';
  fx.appendChild(ring);
  const N = 6;
  for (let i = 0; i < N; i++) {
    const s = document.createElement('div');
    s.className = 'spark';
    const ang = (Math.PI * 2 * i) / N;
    const dist = 16 + Math.random() * 10;
    s.style.setProperty('--tx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--ty', Math.sin(ang) * dist + 'px');
    fx.appendChild(s);
  }
  document.body.appendChild(fx);
  setTimeout(() => fx.remove(), 550);
}
document.addEventListener('pointerdown', e => { ensureAudio(); spawnClickFx(e.clientX, e.clientY); });

// ── 인라인 핸들러 → addEventListener 배선 (모듈 스코프라 전역 onclick 불가) ──
(function wireHandlers(){
  const ACTIONS = {
    startLocalMode, goOnline, createRoom, joinRoom, copyRoomCode,
    startOnlineGame, playAgain, leaveRoomAndReload, reactionConfirm,
    reactionTake, toggleCheatPanel, cheatAddCard, cheatSetHp,
    back: () => showScreen('start'),
  };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) fn(e);
  });
  const pb = document.getElementById('passBtn'); if (pb) pb.onclick = passAction;
  const rc = document.getElementById('roomCodeInput');
  if (rc) rc.addEventListener('input', updateJoinBtn);
})();
