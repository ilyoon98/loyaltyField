
/* =============================================================
   으리챗 난투전 v0.4 — 로컬 AI + 온라인 멀티 (Firebase)
   ============================================================= */

// ── Firebase (단일 인스턴스 모듈) ─────────────────────────────
import { db, FB_READY } from './core/firebase.js';

// ── 데이터·상수 모듈 ─────────────────────────────────────────
import { CARD_DEFS, CARD_KEYS, CARD_ICON, cardIcon, TYPE_TIMING, CONFIG,
         RESPONSE_TIMEOUT, SKIP_GRACE, ABORT_GRACE, ELIM_GRACE, GHOST_GRACE, FIN_GRACE,
         AI_IDS, AI_NAMES } from './data/cards.js';
import { CHARACTERS, charImgHtml, effProb, effValue } from './data/characters.js';
import { drawCard, newHand, rollHit, toArr, sleep } from './util.js';
import { S, myPlayerId } from './core/store.js';
import { showScreen, renderLocalCharSelect, setStatus, setZone, showStageLeft, showStageCenter, showStageRight,
         clearCenterRight, clearAllZones, clearStage, floatNumber, vfxBurst, vfxAt, ensureAudio, tone, playSFX,
         pushLog, appendLog } from './ui/render.js';
import { render, renderHand, startReaction, cancelReaction, reactionConfirm, reactionTake, passAction } from './ui/input.js';

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

// ── 로컬 게임 시작 ────────────────────────────────────────────
function startLocalGame() {
  const aiChars = AI_IDS.map(() => {
    const pool = CHARACTERS.filter(c => c.id !== S.selectedChar);
    return pool[Math.floor(Math.random() * pool.length)].id;
  });
  const players = {
    you: { name:"나", characterId:S.selectedChar, hp:CONFIG.startHp, alive:true, hand:newHand(CONFIG.handSize) }
  };
  AI_IDS.forEach((id, i) => {
    players[id] = { name:AI_NAMES[i], characterId:aiChars[i], hp:CONFIG.startHp, alive:true, hand:newHand(CONFIG.handSize) };
  });
  S.state = { phase:"playing", turnOrder:["you",...AI_IDS], currentTurnIndex:0, players, log:[], winner:null };
  S.pendingCardUse = null;
  document.getElementById('logBox').innerHTML = '';
  showScreen('battle');
  pushLog(`게임 시작! 나(${S.selectedChar}) vs ${AI_IDS.map((id,i)=>`${AI_NAMES[i]}(${aiChars[i]})`).join(', ')}`, 'sys');
  beginTurn();
}

// ── 온라인: 방 만들기 ─────────────────────────────────────────
async function createRoom() {
  const name = document.getElementById('playerNameInput').value.trim();
  if (!name) { setLobbyError('닉네임을 입력하세요'); return; }
  S.myName = name;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  for (let t = 0; t < 20; t++) {
    code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    const snap = await db.ref('rooms/' + code).once('value');
    if (!snap.exists()) break;
  }
  S.roomId = code; S.isHost = true;
  S.gameMode = 'online';
  saveSession();
  sweepGhostRooms();   // 유령 방 정리(Stage 1): 새 방 만들 때 묘지 청소. fire-and-forget.
  await db.ref('rooms/' + S.roomId).set({
    host: S.myUid, phase:'waiting',
    createdAt: firebase.database.ServerValue.TIMESTAMP,   // 신생 방 보호용 age 기준
    players: { [S.myUid]: { name:S.myName, characterId:null } }
  });
  listenRoom();
  showScreen('waiting');
}

// ── 유령 방 정리 (Stage 1) ────────────────────────────────────
// 전원 끊김 + 유예 경과한 방을 다음 createRoom 시 청소. 백엔드 없는 클라 전용 그물.
// 삭제는 per-room 트랜잭션으로 최신값 재확인 → rejoin/phase변경 시 abort. 멱등(이미 없으면 no-op).
function isGhostRoom(data, now) {
  if (!data) return false;
  const pres = data.presence || {};
  // 1차 안전판: 한 명이라도 접속 중이면 유령 아님 (혼자 대기 중인 사람 보호)
  if (Object.values(pres).some(p => p && p.connected === true)) return false;
  // 마지막 이탈 시각 = presence.lastSeen 최대값 (없으면 생성시각, 그것도 없으면 0)
  let lastLeft = 0;
  Object.values(pres).forEach(p => { if (p && p.lastSeen > lastLeft) lastLeft = p.lastSeen; });
  if (!lastLeft) lastLeft = data.createdAt || 0;
  const grace = data.phase === 'finished' ? FIN_GRACE : GHOST_GRACE;
  return now - lastLeft >= grace;
}

async function sweepGhostRooms() {
  try {
    const snap = await db.ref('rooms').once('value');
    const all = snap.val() || {};
    const now = Date.now();
    Object.keys(all).forEach(code => {
      if (!isGhostRoom(all[code], now)) return;        // 읽은 시점 1차 필터
      db.ref('rooms/' + code).transaction(data => {     // 삭제는 트랜잭션 재확인
        // null 반환(삭제). Firebase 트랜잭션 첫 호출은 캐시(=null)로 들어오므로 여기서
        // undefined(abort) 내면 서버 실값을 못 보고 중단됨 → null 반환해 통과시키면
        // 서버 실값으로 재실행되어 아래 isGhostRoom 재확인이 제대로 작동. (이미 없으면 no-op)
        if (!data) return null;                         // 멱등 + optimistic-null 패스 통과
        if (!isGhostRoom(data, Date.now())) return;     // 최신값 재확인 → rejoin 등 시 abort(삭제 취소)
        return null;                                    // 조건 충족 → 방 삭제
      });
    });
  } catch (e) { /* 정리는 best-effort — 실패해도 방 생성엔 영향 없음 */ }
}

// 방 코드가 4자리일 때만 입장 버튼 활성화
function updateJoinBtn() {
  const code = document.getElementById('roomCodeInput').value.trim();
  document.getElementById('joinRoomBtn').disabled = code.length !== 4;
}

// ── 온라인: 방 입장 ───────────────────────────────────────────
async function joinRoom() {
  const name = document.getElementById('playerNameInput').value.trim();
  const code = document.getElementById('roomCodeInput').value.trim().toUpperCase();
  if (!name) { setLobbyError('닉네임을 입력하세요'); return; }
  if (code.length !== 4) { setLobbyError('방 코드 4자리를 입력하세요'); return; }
  S.myName = name;
  const snap = await db.ref('rooms/' + code).once('value');
  if (!snap.exists()) { setLobbyError('방을 찾을 수 없습니다'); return; }
  const data = snap.val();
  if (data.phase !== 'waiting') { setLobbyError('이미 게임이 시작된 방입니다'); return; }
  if (Object.keys(data.players || {}).length >= 4) { setLobbyError('방이 가득 찼습니다 (최대 4명)'); return; }
  S.roomId = code; S.isHost = data.host === S.myUid;
  S.gameMode = 'online';
  saveSession();
  await db.ref('rooms/' + S.roomId + '/players/' + S.myUid).set({ name:S.myName, characterId:null });
  listenRoom();
  showScreen('waiting');
}

// ── 새로고침 복구 (Stage 5b) ──────────────────────────────────
function saveSession()  { sessionStorage.setItem('euri_room', S.roomId); sessionStorage.setItem('euri_name', S.myName); }
function clearSession() { sessionStorage.removeItem('euri_room'); sessionStorage.removeItem('euri_name'); }

// 페이지 로드 시 진행 중이던 온라인 방으로 자동 복귀
async function tryRejoinOnline() {
  if (!FB_READY) return;
  const savedRoom = sessionStorage.getItem('euri_room');
  if (!savedRoom) return;
  S.roomId = savedRoom;
  S.myName = sessionStorage.getItem('euri_name') || '플레이어';
  S.gameMode = 'online';

  const data = (await db.ref('rooms/' + S.roomId).once('value')).val();
  // 방 없음 / 끝난 게임 / 내가 멤버 아님 → 복구 취소
  if (!data || !data.players || !data.players[S.myUid] || data.phase === 'finished') {
    clearSession(); S.roomId = null; S.gameMode = 'local'; return;
  }
  S.isHost = data.host === S.myUid;

  // 진행 중 action이 있으면 재생 생략(snap). S.onlineSeq를 현재 seq로 맞춰 재생 트리거 방지.
  if (data.action) {
    S.onlineSeq = data.action.seq || 0;
    // 내가 그 action의 AP(owner)였다면 내 재생 루프가 사라져 stuck → 취소(done:true).
    // DB players는 재생 중 데미지가 반영 안 되므로(commit 전) 취소 시 깔끔히 직전 상태로 복귀.
    if (data.action.done === false) {
      const ap = toArr(data.turnOrder)[data.currentTurnIndex || 0];
      if (ap === S.myUid) {
        await db.ref('rooms/' + S.roomId).update({ 'action/done': true, 'action/await': null });
      }
    }
  }
  listenRoom();   // onRoomData가 현 상태로 스냅 + watchAwait 시작
}

function setLobbyError(msg) { document.getElementById('lobbyError').textContent = msg; }

// ── Firebase 리스너 ───────────────────────────────────────────
function listenRoom() {
  if (S.roomRef) S.roomRef.off();
  S.roomRef = db.ref('rooms/' + S.roomId);
  S.roomRef.on('value', snap => {
    const data = snap.val();
    if (!data) return;
    if (data.phase === 'waiting') renderWaitingRoom(data);
    else onRoomData(data);
  });
  startPresence();   // 5c-1: 입장 즉시 presence 활성 (대기실부터)
}

// ── presence (5c-1) ───────────────────────────────────────────
// .info/connected로 onDisconnect 자동 재무장 + 별도 presence 노드 감시.
// 게임 상태는 일절 안 건드림 — 순수 감지/표시. 권위·복구는 5c-2~4.
function startPresence() {
  if (S.presenceStarted || !S.roomId) return;
  S.presenceStarted = true;
  const ServerValue = firebase.database.ServerValue;
  db.ref('.info/connected').on('value', snap => {
    if (snap.val() !== true || !S.roomId) return;
    const pref = db.ref('rooms/' + S.roomId + '/presence/' + S.myUid);
    // 끊기면 서버가 실행(=감지 시각이 lastSeen에 박힘) → 5c-4 권위자가 grace 판정
    pref.onDisconnect().set({ connected:false, lastSeen: ServerValue.TIMESTAMP });
    pref.set({ connected:true, lastSeen: ServerValue.TIMESTAMP });
  });
  watchPresence();
}

// 별도 경로 상설 리스너 → S.onlineReplaying 가드와 무관(재생 중에도 감지). watchAwait와 동일 패턴.
function watchPresence() {
  db.ref('rooms/' + S.roomId + '/presence').on('value', snap => {
    S.presenceMap = snap.val() || {};
    applyPresenceUI();
    checkAPRecovery();   // 5c-2: idle AP 끊김 → 턴 스킵
    checkOwnerAbort();   // 5c-3: 행동 중 owner 끊김 → action abort (재생 중에도 도는 경로)
    checkElimination();  // 5c-4: 끊김 30초 → 탈락 + 승패 재계산 + host 이양
  });
}

// 타겟 DOM 패치만 (full render 안 함 → 재생 연출과 안 싸움). 전투/대기실 양쪽 갱신.
function applyPresenceUI() {
  Object.keys(S.presenceMap).forEach(uid => {
    const off = S.presenceMap[uid] && S.presenceMap[uid].connected === false;
    const card = document.getElementById('pl-' + uid);
    if (card) {
      card.classList.toggle('disconnected', off);
      let tag = card.querySelector('.disc-tag');
      if (off && !tag) {
        tag = document.createElement('div');
        tag.className = 'disc-tag';
        tag.textContent = '🔌 연결 끊김';
        card.appendChild(tag);
      } else if (!off && tag) { tag.remove(); }
    }
    const row = document.querySelector('.waiting-player[data-uid="' + uid + '"]');
    if (row) row.classList.toggle('disconnected', off);
  });
}

// ── 5c-2: idle AP 끊김 → 턴 스킵 (권위자 단일 게이트 + 트랜잭션 재검증) ──

// 연결된 생존자 중 turnOrder 최소 인덱스가 나인가 = 결정적 단일 권위자.
// (끊긴 권위자는 connected:false라 자동 제외 → 다음 사람이 승계)
function amRecoveryAuthority() {
  if (S.gameMode !== 'online' || !S.state || !S.state.turnOrder) return false;
  for (const id of S.state.turnOrder) {
    const p = S.state.players[id];
    if (!p || !p.alive) continue;
    if (S.presenceMap[id] && S.presenceMap[id].connected === false) continue;
    return id === S.myUid;
  }
  return false;
}

// AP가 끊김+idle이면 SKIP_GRACE 후 턴 스킵. presence 변화·room 변화 양쪽에서 호출.
function checkAPRecovery() {
  if (S.apRecoveryTimer) { clearTimeout(S.apRecoveryTimer); S.apRecoveryTimer = null; }
  if (S.gameMode !== 'online' || !S.state || S.state.phase !== 'playing') return;
  if (S.onlineReplaying) return;                         // 행동 중(action 진행) — 5c-3 영역, 무시
  const ap = S.state.turnOrder[S.state.currentTurnIndex];
  const apPres = S.presenceMap[ap];
  if (!apPres || apPres.connected !== false) return;   // AP 연결됨/미상 → 할 일 없음
  if (!amRecoveryAuthority()) return;                  // 권위자만 시도(최적화; 진짜 보장은 트랜잭션)
  const elapsed = Date.now() - (apPres.lastSeen || 0);
  if (elapsed >= SKIP_GRACE) {
    skipDisconnectedAP(ap);
  } else {
    // 유예 남음 → 남은 시간 후 재평가 (그 사이 복귀하면 presence 변화로 재호출돼 자연 취소)
    S.apRecoveryTimer = setTimeout(checkAPRecovery, SKIP_GRACE - elapsed + 100);
  }
}

// 트랜잭션: 전제(AP 여전히 끊김 + 유예 경과 + idle) atomic 재검증 후 턴 전진. alive 불변(탈락은 5c-4).
async function skipDisconnectedAP(ap) {
  const now = Date.now();
  await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data) return;
    const order = toArr(data.turnOrder);
    if (order[data.currentTurnIndex || 0] !== ap) return;       // 이미 턴 넘어감 → abort
    const pres = data.presence && data.presence[ap];
    if (!pres || pres.connected !== false) return;              // 재접속함 → abort (Q3)
    if (now - (pres.lastSeen || 0) < SKIP_GRACE) return;        // 유예 전 → abort
    if (data.action && data.action.done === false) return;      // 행동 중 → 5c-2 아님 → abort (Q2)
    let idx = (data.currentTurnIndex + 1) % order.length;
    for (let t = 0; t < order.length; t++) {
      if (data.players[order[idx]].alive) break;
      idx = (idx + 1) % order.length;
    }
    data.currentTurnIndex = idx;
    const nm = (data.players[ap] && data.players[ap].name) || '?';
    data.log = [...toArr(data.log), `${nm} 연결 끊김 — 턴 스킵`];
    return data;
  });
}

// ── 5c-3: owner 행동 중 끊김 → action abort (묶인 spectator 해제) ──
// 재생 중(S.onlineReplaying) 일어나므로 checkAPRecovery와 별개 경로. 턴 처리는 5c-2에 위임.
function checkOwnerAbort() {
  if (S.ownerAbortTimer) { clearTimeout(S.ownerAbortTimer); S.ownerAbortTimer = null; }
  if (S.gameMode !== 'online' || !S.state || !S.state.turnOrder) return;
  const owner = S.state.turnOrder[S.state.currentTurnIndex];   // 재생 중 S.state 스냅샷 = action의 owner(AP)
  const pres = S.presenceMap[owner];
  if (!pres || pres.connected !== false) return;           // owner 연결됨 → 무관
  if (!amRecoveryAuthority()) return;                       // 권위자만(진짜 보장은 트랜잭션)
  const elapsed = Date.now() - (pres.lastSeen || 0);
  if (elapsed >= ABORT_GRACE) abortOwnerAction(owner);     // 0=즉시
  else S.ownerAbortTimer = setTimeout(checkOwnerAbort, ABORT_GRACE - elapsed + 50);
}

// 트랜잭션: in-flight action(done=false)의 owner가 끊겼으면 done=true로 종료.
// → 묶인 spectator의 waitForResolved가 done===true 보고 'ABORT' 탈출(기존 경로). DB players는 pre-action 그대로.
// 턴은 안 건드림 → abort 후 "idle + AP 끊김"이 되어 5c-2가 SKIP_GRACE 뒤 인수.
async function abortOwnerAction(owner) {
  await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data || !data.action || data.action.done !== false) return;   // in-flight 아님 → abort
    const order = toArr(data.turnOrder);
    if (order[data.currentTurnIndex || 0] !== owner) return;           // owner가 AP 아님 → abort
    if (data.action.ownerUid && data.action.ownerUid !== owner) return; // 방어적: ownerUid 불일치
    const pres = data.presence && data.presence[owner];
    if (!pres || pres.connected !== false) return;                     // 재접속 → abort
    data.action.done = true;     // ★ 묶인 spectator 깨우기
    data.action.await = null;    // askDefense 모달 떠있던 타겟의 watchAwait도 닫힘
    const nm = (data.players[owner] && data.players[owner].name) || '?';
    data.log = [...toArr(data.log), `${nm} 연결 끊김 — 행동 취소`];
    return data;
  });
}

// ── 5c-4: 끊김 30초 경과 → 탈락 + 승패 재계산 + host 이양 ──
// presence·room 변화 양쪽에서 호출. amRecoveryAuthority 단일 집행 + 트랜잭션 재검증.
// in-flight action 중에는 보류(큐 target desync 방지) — 5c-3가 owner 끊김은 즉시 abort하므로 곧 풀림.
function checkElimination() {
  if (S.elimTimer) { clearTimeout(S.elimTimer); S.elimTimer = null; }
  if (S.gameMode !== 'online' || !S.state || S.state.phase !== 'playing') return;
  if (S.onlineReplaying) return;                            // 행동 재생 중 → 정산 후 다시 평가
  if (!amRecoveryAuthority()) return;                     // 권위자만(진짜 보장은 트랜잭션)
  const now = Date.now();
  let soonest = Infinity, anyExpired = false;
  for (const id of S.state.turnOrder) {
    const p = S.state.players[id];
    if (!p || !p.alive) continue;
    const pres = S.presenceMap[id];
    if (!pres || pres.connected !== false) continue;      // 연결됨/미상 → 대상 아님
    const elapsed = now - (pres.lastSeen || 0);
    if (elapsed >= ELIM_GRACE) anyExpired = true;
    else soonest = Math.min(soonest, ELIM_GRACE - elapsed);
  }
  if (anyExpired) { eliminateDisconnected(); return; }
  if (soonest !== Infinity) S.elimTimer = setTimeout(checkElimination, soonest + 100);
}

// 단일 트랜잭션: 유예 경과한 끊김자 일괄 탈락 → 승패 재계산 → currentTurnIndex 보정 → host 이양.
// 끊김으로 alive<=1 되면 마지막 끊긴 사람(lastSeen 최대) 우승. (전투 전멸 무효는 commitSettlement 담당)
async function eliminateDisconnected() {
  const now = Date.now();
  await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data || data.phase !== 'playing') return;
    if (data.action && data.action.done === false) return;   // in-flight → 보류(abort)
    const order = toArr(data.turnOrder);
    // 1) 전제 재검증: 여전히 끊김 + 유예 경과 + alive 인 대상만
    const victims = [];
    order.forEach(id => {
      const p = data.players[id];
      if (!p || !p.alive) return;
      const pres = data.presence && data.presence[id];
      if (!pres || pres.connected !== false) return;
      if (now - (pres.lastSeen || 0) < ELIM_GRACE) return;
      victims.push(id);
    });
    if (!victims.length) return;                             // 전부 복귀/이미 처리됨 → abort
    // 2) 탈락 적용
    victims.forEach(id => { data.players[id].alive = false; });
    const nm = id => (data.players[id] && data.players[id].name) || '?';
    const logArr = toArr(data.log);
    victims.forEach(id => logArr.push(`🔌 ${nm(id)} 30초 연결 끊김 — 탈락`));
    // 3) 승패 재계산
    const alive = order.filter(id => data.players[id].alive);
    if (alive.length <= 1) {
      data.phase = 'finished';
      if (alive.length === 1) {
        data.winner = alive[0];
      } else {
        // 전원 끊김 동시 탈락 → 마지막에 끊긴 사람(lastSeen 최대) 우승
        let best = null, bestSeen = -1;
        victims.forEach(id => {
          const ls = (data.presence[id] && data.presence[id].lastSeen) || 0;
          if (ls > bestSeen) { bestSeen = ls; best = id; }
        });
        data.winner = best;
        logArr.push(`👑 ${nm(best)} — 마지막까지 연결을 지킨 자, 우승`);
      }
    } else {
      // 4) 현재 AP가 탈락했으면 다음 생존자로 보정
      let idx = data.currentTurnIndex || 0;
      if (!data.players[order[idx]].alive) {
        for (let t = 0; t < order.length; t++) {
          idx = (idx + 1) % order.length;
          if (data.players[order[idx]].alive) break;
        }
        data.currentTurnIndex = idx;
      }
    }
    // 5) host 이양 (탈락자가 host였을 때만). owner 권위 단일 write 안에서만 변경.
    if (victims.includes(data.host)) {
      const conn = order.find(id => data.players[id].alive &&
                   data.presence[id] && data.presence[id].connected !== false);
      const newHost = conn || alive[0] || data.host;
      if (newHost !== data.host) { data.host = newHost; logArr.push(`👑 방장 이양 → ${nm(newHost)}`); }
    }
    data.log = logArr;
    return data;
  });
}

// ── 대기실 렌더링 ─────────────────────────────────────────────
function renderWaitingRoom(data) {
  // 재대결 등으로 phase가 waiting이 되면 전원 대기화면으로 전환 (승리화면 등에서 복귀)
  if (!document.getElementById('screen-waiting').classList.contains('active')) {
    showScreen('waiting');
    S.prevLogLen = 0;        // 새 게임 로그가 처음부터 찍히도록
    document.getElementById('logBox').innerHTML = '';
  }
  saveSession();          // 대기방에 있는 동안 새로고침 복귀 보장
  document.getElementById('roomCodeDisplay').textContent = S.roomId;
  S.isHost = data.host === S.myUid;

  const list = document.getElementById('waitingPlayerList');
  list.innerHTML = '';
  Object.entries(data.players || {}).forEach(([uid, p]) => {
    const div = document.createElement('div');
    const off = S.presenceMap[uid] && S.presenceMap[uid].connected === false;
    div.className = 'waiting-player' + (off ? ' disconnected' : '');
    div.dataset.uid = uid;
    const me = uid === S.myUid;
    div.innerHTML = `<span style="color:${me?'var(--blue)':'var(--ink)'}">${p.name}${uid===data.host?' 👑':''}${off?' 🔌':''}</span><span style="${p.characterId?"color:var(--gold);font-family:'Black Han Sans';font-size:1rem":'color:var(--muted);font-size:.85rem'}">${p.characterId||'선택 중...'}</span>`;
    list.appendChild(div);
  });

  const myChar = data.players[S.myUid]?.characterId;
  const grid = document.getElementById('onlineCharGrid');
  grid.innerHTML = '';
  CHARACTERS.forEach(c => {
    const div = document.createElement('div');
    div.className = 'char-card' + (c.id === myChar ? ' sel' : '');
    div.innerHTML = `${charImgHtml(c)}<div class="nm">${c.id}</div><div class="ef">${c.desc}</div>`;
    div.onclick = () => db.ref('rooms/'+S.roomId+'/players/'+S.myUid+'/characterId').set(c.id);
    grid.appendChild(div);
  });

  const count = Object.keys(data.players||{}).length;
  const allPicked = Object.values(data.players||{}).every(p => p.characterId);
  const btn = document.getElementById('onlineStartBtn');
  const st  = document.getElementById('waitingStatus');
  if (S.isHost) {
    btn.style.display = 'block';
    if (count < 2)       { btn.disabled = true;  btn.textContent = `게임 시작 (최소 2명 필요)`; }
    else if (!allPicked) { btn.disabled = true;  btn.textContent = `모두 캐릭터 선택 후 시작`; }
    else                 { btn.disabled = false; btn.textContent = `게임 시작 (${count}명)`; }
    st.textContent = '';
  } else {
    btn.style.display = 'none';
    st.textContent = allPicked ? '방장이 게임을 시작할 때까지 대기 중...' : '캐릭터를 선택하세요';
  }
}

function copyRoomCode() {
  navigator.clipboard?.writeText(S.roomId).then(() => {
    const el = document.getElementById('roomCodeDisplay');
    const orig = el.textContent;
    el.textContent = '복사됨!';
    setTimeout(() => { el.textContent = orig; }, 1200);
  });
}

// ── 온라인 게임 시작 ──────────────────────────────────────────
async function startOnlineGame() {
  const snap = await db.ref('rooms/'+S.roomId).once('value');
  const data = snap.val();
  const entries = Object.entries(data.players||{});
  if (entries.length < 2) { alert('최소 2명 필요'); return; }
  if (!entries.every(([,p])=>p.characterId)) { alert('모든 플레이어가 캐릭터를 선택해야 합니다'); return; }

  const turnOrder = entries.map(([uid])=>uid);
  for (let i = turnOrder.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [turnOrder[i],turnOrder[j]] = [turnOrder[j],turnOrder[i]];
  }
  const players = {};
  entries.forEach(([uid,p]) => {
    players[uid] = { name:p.name, characterId:p.characterId, hp:CONFIG.startHp, alive:true, hand:newHand(CONFIG.handSize) };
  });
  const logObj = { 0:`게임 시작! 순서: ${turnOrder.map(u=>players[u].name).join(' → ')}` };
  await db.ref('rooms/'+S.roomId).update({
    phase:'playing', players, turnOrder, currentTurnIndex:0,
    log:logObj, winner:null
  });
}

// ── 온라인 상태 수신 ──────────────────────────────────────────
// DB 데이터 → 로컬 S.state 미러 갱신. 신규 로그 배열 반환(append는 호출자가 결정).
function syncStateFromData(data) {
  const logArr = toArr(data.log);
  const newLogs = logArr.slice(S.prevLogLen);
  S.prevLogLen = logArr.length;

  S.state = {
    phase: data.phase,
    players: data.players || {},
    turnOrder: toArr(data.turnOrder),
    currentTurnIndex: data.currentTurnIndex || 0,
    log: logArr,
    winner: data.winner || null,
    voided: data.voided || false,   // 5c-4: 전투 동시 전멸 무효
  };
  Object.values(S.state.players).forEach(p => { p.hand = toArr(p.hand); });

  if (!document.getElementById('screen-battle').classList.contains('active')) {
    document.getElementById('logBox').innerHTML = '';
    showScreen('battle');
  }
  return newLogs;
}

// DB 변경 디스패처: 새 액션이면 재생 시작, 아니면 idle 렌더.
function onRoomData(data) {
  // 응답 모달 상설 리스너 시작 (게임 진입 시 1회). 재생 가드보다 먼저.
  if (!S.awaitWatchStarted && data.phase && data.phase !== 'waiting') {
    S.awaitWatchStarted = true;
    watchAwait();
  }
  // 재생 중에는 어떤 갱신도 무시한다.
  // (1) 재생 중 적용한 HP/연출 로컬 미러를 DB 옛값으로 덮어쓰는 것 방지
  // (2) await/input/queue 변경은 재생기 내부 waiter가 직접 처리
  if (S.onlineReplaying) return;

  const newLogs = syncStateFromData(data);

  if (data.phase === 'finished') { showWin(); return; }

  const act = data.action;
  // 새 액션 감지 → 큐 재생 시작 (아직 안 끝난 액션)
  if (act && (act.seq || 0) > S.onlineSeq && act.done === false) {
    S.onlineSeq = act.seq;
    playOnlineAction(normalizeAction(act));
    return;
  }

  // idle 상태: 신규 로그 표시 + 렌더 + 상태바
  newLogs.forEach(msg => appendLog(msg, classifyLog(msg)));
  render();
  if (S.reactionCtx) return;   // 반응 진행 중이면 상태바 덮어쓰지 않음
  const curId = S.state.turnOrder[S.state.currentTurnIndex];
  if (curId === S.myUid) setStatus('내 턴 — 카드를 사용하거나 패스하세요');
  else                 setStatus(`${S.state.players[curId]?.name || '?'}의 턴...`);
  checkAPRecovery();   // 5c-2: 턴이 이미-끊긴 AP에게 넘어온 경우도 감지
  checkElimination();  // 5c-4: room 변화 시에도 탈락 평가 (presence 무변화 케이스)
}

function classifyLog(msg) {
  if (msg.includes('탈락')) return 'sys';
  if (msg.includes('피해'))  return 'hit';
  if (msg.includes('회복'))  return 'heal';
  if (msg.includes('방어'))  return 'block';
  if (msg.includes('반사') || msg.includes('떠넘김')) return 'ref';
  if (msg.includes('빗나감')) return 'miss';
  return 'sys';
}

// ── 승리 화면 ────────────────────────────────────────────────
function showWin() {
  clearSession();   // 게임 종료 → 새로고침 시 자동 복귀 안 함
  // 온라인은 "나가기"(방 삭제) 버튼 노출, 로컬은 "다시 하기"만
  document.getElementById('winLeaveBtn').style.display = (S.gameMode === 'online') ? '' : 'none';
  const meId = S.gameMode === 'online' ? S.myUid : 'you';
  // 5c-4: 전투 동시 전멸 무효 — 승자 없음
  if (S.state.voided) {
    document.getElementById('winText').textContent = '그리고 아무도 없었다';
    document.getElementById('winText').style.color  = 'var(--muted)';
    document.getElementById('winSub').textContent   = '모두가 쓰러졌다. 무효.';
    showScreen('win');
    return;
  }
  const won  = S.state.winner === meId;
  const winnerName = S.state.winner ? (S.state.players[S.state.winner]?.name||'?') : '없음';
  document.getElementById('winText').textContent = won ? '승리!' : `${winnerName} 우승!`;
  document.getElementById('winText').style.color  = won ? 'var(--gold)' : 'var(--red)';
  document.getElementById('winSub').textContent   = won ? '마지막까지 살아남았다!' : '다음엔 더 잘 싸워보자.';
  showScreen('win');
}

// 유령 방 정리 Stage 2: "다시 하기" 시 자기 방(finished) 즉시 삭제 후 새로고침.
// finished는 재사용 없는 종착이라 유예 없이 바로 정리(흔한 케이스 단축). 로컬 모드는 그냥 reload.
async function leaveRoomAndReload() {
  if (S.gameMode === 'online' && S.roomId && FB_READY) {
    try {
      if (S.roomRef) S.roomRef.off();   // 삭제 시 내 리스너 null 콜백 방지
      await db.ref('rooms/' + S.roomId).transaction(data => {
        if (!data) return null;                 // 이미 없음 → no-op (멱등)
        if (data.phase !== 'finished') return;  // 안전: finished 아니면 삭제 안 함
        return null;                            // finished 방 삭제
      });
    } catch (e) { /* best-effort — 실패해도 Stage 1 sweep이 나중에 정리 */ }
  }
  clearSession();
  location.reload();
}

// "다시 하기": 온라인은 같은 방을 캐릭터 선택(waiting)으로 되돌려 재대결, 로컬은 새로고침.
function playAgain() {
  if (S.gameMode === 'online' && S.roomId && FB_READY) { rematchOnline(); return; }
  location.reload();
}

// 재대결: finished 방을 waiting(캐릭터 선택)으로 리셋. 플레이어는 유지(이름·캐릭터),
// 게임 상태(hp/alive/hand)·승패만 제거. action은 건드리지 않음(seq 단조증가 유지 → S.onlineSeq 정상).
async function rematchOnline() {
  await db.ref('rooms/' + S.roomId).once('value');   // 캐시 프라임 (트랜잭션 첫 호출 null 회피)
  await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data) return;                        // 방 없으면 no-op
    if (data.phase !== 'finished') return;    // 안전: 끝난 방만 리셋
    const players = {};
    Object.entries(data.players || {}).forEach(([uid, p]) => {
      players[uid] = { name: p.name, characterId: p.characterId || null };
    });
    data.players = players;
    data.phase   = 'waiting';
    data.winner  = null;
    data.voided  = null;
    return data;
  });
  saveSession();   // 재대결 방 — 새로고침 시 복귀
}

// ── 턴 시작 ──────────────────────────────────────────────────
function beginTurn() {
  if (checkWin()) return;
  const cur = S.state.turnOrder[S.state.currentTurnIndex];
  if (!S.state.players[cur].alive) { nextTurn(); return; }
  const p = S.state.players[cur];
  S.pendingCardUse = null;
  clearStage();
  render();
  const myId = S.gameMode === 'online' ? S.myUid : 'you';
  if (cur === myId) {
    setStatus('내 턴 — 카드를 사용하거나 패스하세요');
  } else {
    setStatus(`${p.name}의 턴…`);
    if (S.gameMode === 'local') setTimeout(aiTurn, 900);
  }
}

export function nextTurn() {
  S.state.currentTurnIndex = (S.state.currentTurnIndex + 1) % S.state.turnOrder.length;
  beginTurn();
}

// ── 카드 사용 ────────────────────────────────────────────────





// ── MyTurn 카드 처리 ─────────────────────────────────────────
export function resolveMyTurnCard(attackerId, targetId, key) {
  // 온라인: 큐를 만들어 DB로 (기획 12-1). owner 가드는 startOnlineAction 트랜잭션에서.
  if (S.gameMode === 'online') { startOnlineAction(attackerId, targetId, key); return; }

  // ── 로컬 ──
  const def = CARD_DEFS[key];

  if (def.type === 'HEAL') {
    const q = buildHealQueue(attackerId, targetId, key);
    playQueue(q, () => { if (!checkWin()) setTimeout(nextTurn, 400); });
    return;
  }
  if (def.type === 'ALL') {
    const q = buildAllQueue(attackerId, key);
    playQueue(q, () => { if (!checkWin()) setTimeout(nextTurn, 400); });
    return;
  }
  if (def.type === 'ATK') {
    const q = buildAtkQueue(attackerId, targetId, key);
    playQueue(q, () => { if (!checkWin()) setTimeout(nextTurn, 400); });
    return;
  }
}

// ── 피격 반응 ────────────────────────────────────────────────
function getReactionCards(playerId, aoe) {
  return toArr(S.state.players[playerId].hand)
    .map((k,i) => ({k,i}))
    .filter(o => TYPE_TIMING[CARD_DEFS[o.k]?.type] === 'OnHit');
}

function closeReactModal() { document.getElementById('reactOverlay').classList.remove('active'); }

// ── 데미지 적용 ───────────────────────────────────────────────
function applyDamage(targetId, dmg, sourceId, label) {
  const p = S.state.players[targetId];
  if (!p.alive) return;
  p.hp -= dmg;
  pushLog(`${p.name} ${label}으로 ${dmg} 피해 (HP ${Math.max(0,p.hp)})`, 'hit');
  if (p.hp <= 0) { p.hp = 0; p.alive = false; pushLog(`💀 ${p.name} 탈락!`, 'sys'); }
}

// ── 이벤트 큐 + 재생기 (기획 12장) ────────────────────────────

// ── 큐 재생 중 공격자/피격자 강조 ──────────────────────────────

function setQueueHighlight(attacker, targeted) {
  S.queueHighlight.attacker = attacker;
  S.queueHighlight.targeted = targeted;
  // render() 호출 없이 즉시 DOM 패치
  if (!S.state?.turnOrder) return;
  S.state.turnOrder.forEach(id => {
    const el = document.getElementById('pl-' + id);
    if (!el) return;
    el.classList.toggle('active-turn', id === attacker);
    el.classList.toggle('targeted',    id === targeted);
  });
}

// 단일 ATK 한 건 → 이벤트 배열 (계산만, 실제 적용은 재생기에서 박자별로)
function buildAtkQueue(attackerId, targetId, key) {
  const def = CARD_DEFS[key];
  const atkChar = S.state.players[attackerId].characterId;
  const q = [];
  // 프로틴 등: 공격 시 자기 회복 (명중 여부와 무관)
  if (def.trigger === atkChar && def.plusType === 'HEAL')
    q.push({ kind:'selfheal', target:attackerId, amount:def.plusValue, card:key });
  q.push({ kind:'announce', actor:attackerId, target:targetId, card:key });
  const hit = rollHit(effProb(key, atkChar));
  q.push({ kind:'hitcheck', target:targetId, card:key, hit });
  if (hit) q.push({ kind:'askDefense', attacker:attackerId, target:targetId, item:key, incoming:def.value });
  return q;
}

// 전체공격(ALL) → 대상별 단계 이벤트 (기획 12-3: 대상마다 명중판정 + 방어 기회)
// 한꺼번에 처리하지 않고 대상 하나씩 꺼내 hitcheck→askDefense(DEF/맞기만)→damage.
function buildAllQueue(attackerId, key) {
  const def = CARD_DEFS[key];
  const atkChar = S.state.players[attackerId].characterId;
  const q = [{ kind:'announce', actor:attackerId, card:key, aoe:true }];
  const targets = S.state.turnOrder.filter(id => id !== attackerId && S.state.players[id].alive);
  targets.forEach((tid, idx) => {
    if (idx > 0) q.push({ kind:'clearCR' });
    const hit = rollHit(effProb(key, atkChar));
    q.push({ kind:'hitcheck', target:tid, card:key, hit, aoe:true });
    if (hit) q.push({ kind:'askDefense', attacker:attackerId, target:tid, item:key, incoming:def.value, aoe:true });
  });
  return q;
}

// 피격자 응답 → 후속 이벤트(연출+데미지). 반응 카드 소모는 이 시점에 처리. (v8: 연쇄 허용)
function buildReactionEvents(attackerId, targetId, atkKey, dmg, choice, aoe) {
  const evs  = [];
  const tName = S.state.players[targetId].name;
  const tHand = S.state.players[targetId].hand;
  const tChar = S.state.players[targetId].characterId;

  // ── 그냥 맞기 ──────────────────────────────────────────────
  if (choice === 'take') {
    evs.push({ kind:'react', text:`😣 ${tName}, 그냥 맞기`,
               log:`${tName} 그냥 맞기`, logKind:'sys', stageCls:'' });
    evs.push({ kind:'damage', target:targetId, amount:dmg,
               label:CARD_DEFS[atkKey]?.name || '공격' });
    return evs;
  }

  // ── 방어(DEF) — 단일(AI)/다중(플레이어) 통합 처리 ──────────
  // choice.defCards: 다중 DEF 배열 / choice.k + DEF type: 단일 → 배열 정규화
  const defKeys = choice.defCards
    ? choice.defCards
    : (CARD_DEFS[choice.k]?.type === 'DEF' ? [choice.k] : null);

  if (defKeys) {
    defKeys.forEach(k => { const i = tHand.indexOf(k); if (i >= 0) tHand.splice(i, 1); });
    // 보충 없음 — 연쇄 종료 후 일괄 보충 (v8)
    const totalReduce = defKeys.reduce((s, k) => s + effValue(k, tChar), 0);
    const final = Math.max(0, dmg - totalReduce);
    const names = defKeys.map(k => CARD_DEFS[k]?.name || k).join('+');
    evs.push({ kind:'react', target:targetId,
      text:`🛡 ${tName} 막음!<br><small>−${totalReduce} 경감</small>`,
      log:`${tName}: ${names} 방어 (−${totalReduce}) → ${final} 피해`,
      logKind:'block', stageCls:'block' });
    if (final > 0) evs.push({ kind:'damage', target:targetId, amount:final, label:'관통' });
    return evs;
  }

  // ── 반사/튕기기 ────────────────────────────────────────────
  const rKey = choice.k;
  const rDef = CARD_DEFS[rKey];
  const ri = tHand.indexOf(rKey);
  if (ri >= 0) tHand.splice(ri, 1);   // 소모, 보충 없음 (v8)

  if (rDef.type === 'REFLECT') {
    evs.push({ kind:'react',
      text:`🔄 ${tName} 반사!<br><small>공격자에게 되돌림</small>`,
      log:`${tName}: ${rDef.name}! 공격자에게 ${dmg} 반사`, logKind:'ref', stageCls:'ref' });
    evs.push({ kind:'clearAll' });
    evs.push({ kind:'counterAnnounce', from:targetId, to:attackerId, label:'반사', amount:dmg });
    // v8: 1회 종결 폐지 → chain askDefense (incoming:dmg 명시)
    evs.push({ kind:'askDefense', attacker:targetId, target:attackerId,
               item:atkKey, incoming:dmg, chain:true, aoe:false });
    evs.push({ kind:'restoreAllAnnounce', actor:attackerId, card:atkKey, aoe:!!aoe });

  } else if (rDef.type === 'Bounce') {
    let nT = 1;
    if (rDef.trigger === tChar && rDef.plusType === 'Target') nT += rDef.plusValue;
    evs.push({ kind:'react',
      text:`🥋 ${tName} 떠넘김!<br><small>랜덤 ${nT}명에게</small>`,
      log:`${tName}: ${rDef.name}! ${dmg} 데미지를 랜덤 ${nT}명에게 떠넘김`,
      logKind:'ref', stageCls:'ref' });
    // victim을 build 시점에 굴려 baking (온라인 결정성 — 재생 시점 롤링 금지).
    // 다중 bounce는 splice 시점 alive로 일괄 baking, 중간에 죽은 대상은 counterAnnounce dead-skip.
    const aliveNow = S.state.turnOrder.filter(id => S.state.players[id].alive);
    for (let n = 0; n < nT; n++) {
      const victim = aliveNow[Math.floor(Math.random() * aliveNow.length)];
      evs.push({ kind:'clearAll' });
      evs.push({ kind:'counterAnnounce', from:targetId, to:victim, label:'떠넘김', amount:dmg });
      if (victim === targetId) {
        // 자기 자신에게 튕김 → 즉시 맞기 (추가 반응 없음, askDefense 없음 → chainCount 무증가)
        evs.push({ kind:'damage', target:victim, amount:dmg, label:'자기 튕기기' });
      } else {
        // 연쇄: victim이 다시 응답 가능 (incoming:dmg 명시 → 강제맞기 시 올바른 데미지)
        evs.push({ kind:'askDefense', attacker:targetId, target:victim,
                   item:atkKey, incoming:dmg, chain:true });
      }
    }
    evs.push({ kind:'restoreAllAnnounce', actor:attackerId, card:atkKey, aoe:!!aoe });
  }

  return evs;
}

// 피격자에게 방어/반사/바운스/맞기 입력 요청 → choice 반환 (Promise)
function askDefense(attackerId, targetId, atkKey, dmg, aoe) {
  return new Promise(resolve => {
    const reactions = getReactionCards(targetId, aoe);
    if (targetId === myPlayerId()) {
      startReaction(attackerId, targetId, atkKey, dmg, reactions, resolve, false);
    } else {
      let choice = 'take';
      if (reactions.length > 0 && Math.random() < 0.5)
        choice = reactions[Math.floor(Math.random() * reactions.length)];
      setTimeout(() => resolve(choice), 500);
    }
  });
}

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
async function renderEventVisual(ev, q, i) {
  if (ev.kind === 'selfheal') {
    const p = S.state.players[ev.target];
    const caster = ev.actor && ev.actor !== ev.target ? S.state.players[ev.actor] : null;
    p.hp = Math.min(CONFIG.maxHp, p.hp + ev.amount);
    if (caster) {
      pushLog(`${caster.name} → ${p.name}: ${CARD_DEFS[ev.card].name}으로 HP ${ev.amount} 회복`, 'heal');
      showStageLeft(`<span class="s-card">${cardIcon(ev.card)}</span>${caster.name} → ${p.name}<br>HP +${ev.amount}`, 'heal');
    } else {
      pushLog(`${p.name}: ${CARD_DEFS[ev.card].name} 효과로 HP ${ev.amount} 회복`, 'heal');
      showStageLeft(`<span class="s-card">${cardIcon(ev.card)}</span>${p.name} HP +${ev.amount}`, 'heal');
    }
    render(); floatNumber(ev.target, ev.amount, true);
    vfxAt(ev.target, 'stageLeft', 'heal'); playSFX('heal');
    await sleep(700);

  } else if (ev.kind === 'announce') {
    const a = S.state.players[ev.actor];
    setQueueHighlight(ev.actor, ev.aoe ? null : ev.target || null);
    if (ev.aoe) {
      showStageLeft(`<span class="s-card">${cardIcon(ev.card)}</span>${CARD_DEFS[ev.card].name}!<br><small>${a.name}의 전체공격</small>`, 'aoe');
      setStatus(`${a.name}의 턴`);
      pushLog(`${a.name}: ${CARD_DEFS[ev.card].name} 전체공격!`, 'sys');
    } else {
      const t = S.state.players[ev.target];
      showStageLeft(`<span class="s-card">${cardIcon(ev.card)}</span>${a.name} → ${t.name}<br>${CARD_DEFS[ev.card].name}!`, 'atk');
      setStatus(`${a.name}의 턴`);
      pushLog(`${a.name} → ${t.name}에게 ${CARD_DEFS[ev.card].name} 공격!`, 'sys');
    }
    render(); await sleep(900);

  } else if (ev.kind === 'hitcheck') {
    // 죽은 대상 skip (ALL build 시점 이후 연쇄로 먼저 죽은 경우). owner/spectator 동일 판정.
    if (!S.state.players[ev.target]?.alive) return;
    if (ev.aoe) {
      if (ev.hit) {
        setQueueHighlight(S.queueHighlight.attacker, ev.target);
        showStageCenter('🎯 명중!', 'atk');
        await sleep(500);
      } else {
        setQueueHighlight(S.queueHighlight.attacker, null);
        showStageCenter(`<span class="s-card">💨</span>빗나감!<br><small>${S.state.players[ev.target].name}</small>`, 'miss');
        pushLog(`${CARD_DEFS[ev.card].name} → ${S.state.players[ev.target].name} 빗나감!`, 'miss');
        render(); await sleep(800);
      }
    } else {
      if (!ev.hit) {
        setQueueHighlight(S.queueHighlight.attacker, null);
        showStageRight(`<span class="s-card">💨</span>빗나감!<br><small>${S.state.players[ev.target].name}</small>`, 'miss');
        pushLog(`${CARD_DEFS[ev.card].name} → ${S.state.players[ev.target].name} 빗나감!`, 'miss');
        render(); await sleep(800);
      }
    }

  } else if (ev.kind === 'react') {
    showStageCenter(ev.text, ev.stageCls || '');
    if (ev.log) pushLog(ev.log, ev.logKind);
    render();
    if (ev.stageCls === 'block' && ev.target) { vfxAt(ev.target, 'stageCenter', 'block'); playSFX('block'); }
    await sleep(800);

  } else if (ev.kind === 'damage') {
    if (!S.state.players[ev.target]?.alive) return;
    showStageRight(`<span class="big-num">−${ev.amount}</span><br><small>${S.state.players[ev.target].name} · ${ev.label}</small>`, 'dmg');
    applyDamage(ev.target, ev.amount, null, ev.label);
    render(); floatNumber(ev.target, ev.amount, false);
    vfxAt(ev.target, 'stageRight', 'dmg'); playSFX('dmg');
    await sleep(800);

  } else if (ev.kind === 'clearCR') {
    setQueueHighlight(S.queueHighlight.attacker, null);
    clearCenterRight();
    await sleep(250);

  } else if (ev.kind === 'clearAll') {
    clearAllZones();
    await sleep(300);

  } else if (ev.kind === 'counterAnnounce') {
    // victim(ev.to)은 buildReactionEvents에서 baking됨 (RNG 없음 — 결정적, 온라인 동기화 안전).
    // baking된 대상이 그새 죽었으면 이 패턴(다음 askDefense/damage)을 스킵.
    if (!S.state.players[ev.to]?.alive) {
      const nxt = q[i + 1];
      if (nxt && (nxt.kind === 'damage' || nxt.kind === 'askDefense') && nxt.target === ev.to)
        q.splice(i + 1, 1);
      return;
    }
    const fromName = S.state.players[ev.from]?.name || '?';
    const toName   = S.state.players[ev.to]?.name   || '?';
    setQueueHighlight(ev.from, ev.to);
    showStageLeft(`${fromName} → ${toName}<br><small>${ev.label} 데미지 ${ev.amount}</small>`, 'atk');
    await sleep(700);

  } else if (ev.kind === 'restoreAllAnnounce') {
    if (!ev.aoe) return;
    const a = S.state.players[ev.actor];
    showStageLeft(`<span class="s-card">${cardIcon(ev.card)}</span>${CARD_DEFS[ev.card].name}!<br><small>${a.name}의 전체공격</small>`, 'aoe');
    await sleep(400);
  }
}

// 재생기(로컬): 큐를 한 박자씩 소비 (기획 12장 v8)
async function playQueue(q, onDone) {
  S.isPlaying = true;
  let chainCount = 0;   // 한 행동 내 되받아치기 횟수 (안전 상한 20회)
  render();

  for (let i = 0; i < q.length; i++) {
    const ev = q[i];

    if (ev.kind === 'askDefense') {
      // 죽은 대상에겐 방어 요청 안 함 (ALL build 이후 연쇄로 먼저 죽은 경우)
      if (!S.state.players[ev.target]?.alive) continue;   // for 루프가 i++ 처리
      setQueueHighlight(ev.attacker, ev.target);
      if (ev.chain && chainCount >= 20) {
        showStageCenter('⛔ 연쇄 종료!', 'miss');
        pushLog('연쇄 상한(20회) 도달 — 강제 맞기', 'sys');
        await sleep(900);
        q.splice(i + 1, 0,
          { kind:'react', text:`😵 강제 맞기`, log:`${S.state.players[ev.target]?.name} 강제 맞기`, logKind:'sys', stageCls:'' },
          { kind:'damage', target:ev.target, amount:ev.incoming, label:'연쇄 종료' }
        );
        continue;
      }
      if (ev.chain) chainCount++;
      setStatus(`${S.state.players[ev.target]?.name || '?'}의 응답을 기다리는 중...`);
      const choice = await askDefense(ev.attacker, ev.target, ev.item, ev.incoming, ev.aoe);
      const reactEvents = buildReactionEvents(ev.attacker, ev.target, ev.item, ev.incoming, choice, ev.aoe);
      q.splice(i + 1, 0, ...reactEvents);
    } else {
      await renderEventVisual(ev, q, i);
    }
  }

  // ── 행동 종료: 강조 해제 후 손패 일괄 보충 (v8) ─────────────
  S.queueHighlight = { attacker: null, targeted: null };
  S.state.turnOrder.forEach(id => {
    const p = S.state.players[id];
    if (!p.alive) return;
    while (p.hand.length < CONFIG.maxHand) p.hand.push(drawCard());
  });

  S.isPlaying = false;
  clearAllZones();
  render();
  if (onDone) onDone();
}

// ── AI 턴 ─────────────────────────────────────────────────────
function aiTurn() {
  const curId = S.state.turnOrder[S.state.currentTurnIndex];
  const ai = S.state.players[curId];
  if (!ai.alive) { nextTurn(); return; }

  const playable = ai.hand.map((k,i)=>({k,i})).filter(o=>TYPE_TIMING[CARD_DEFS[o.k].type]==='MyTurn');
  if (playable.length === 0) {
    ai.hand.push(drawCard());
    pushLog(`${ai.name}은 패스했다. (카드 1장 획득)`, 'sys');
    render(); setTimeout(nextTurn, 500); return;
  }

  const pick = playable[Math.floor(Math.random()*playable.length)];
  ai.hand.splice(ai.hand.indexOf(pick.k), 1);
  // 보충 없음 — 연쇄 종료 후 일괄 보충 (v8)

  const def = CARD_DEFS[pick.k];
  let targetId = null;
  if (def.type === 'ATK') {
    const cands = S.state.turnOrder.filter(id => id !== curId && S.state.players[id].alive);
    targetId = cands[Math.floor(Math.random()*cands.length)];
    // 공격 로그는 큐의 announce 박자에서 찍는다 (로컬 ATK)
  } else if (def.type === 'HEAL') {
    targetId = curId;   // AI는 자신을 회복
  }
  resolveMyTurnCard(curId, targetId, pick.k);
}

// ── 승리 체크 ────────────────────────────────────────────────
function checkWin() {
  const alive = S.state.turnOrder.filter(id => S.state.players[id].alive);
  if (alive.length <= 1) {
    S.state.phase = 'finished'; S.state.winner = alive[0] || null;
    S.state.voided = (alive.length === 0);   // 5c-4: 동시 전멸 무효
    if (S.state.voided) pushLog('그리고 아무도 없었다.', 'sys');
    showWin(); return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// 온라인 액션(큐) — 기획 12-1. owner(현재 AP)가 큐를 만들고 랜덤을 baking,
// DB에 올리면 모든 클라가 동일 재생. askDefense에서 피격자 입력을 DB로 주고받음.
// Stage 3: 단일 ATK / HEAL / ALL, 반응은 방어/반사/튕기기(연쇄)/맞기 전부 지원.
// ══════════════════════════════════════════════════════════════
const actionRef = () => db.ref('rooms/' + S.roomId + '/action');

// 회복 카드. 대상(자신 포함)을 healTarget로 받음. 회복량 보너스는 시전자 캐릭터 기준.
function buildHealQueue(actorId, healTarget, key) {
  const ch = S.state.players[actorId].characterId;
  const tgt = healTarget || actorId;
  return [{ kind:'selfheal', actor:actorId, target:tgt, amount:effValue(key, ch), card:key }];
}

// owner 진입점: 카드 확정 후 호출. 트랜잭션 가드로 "내가 진짜 AP인지" 원자적 확인 후 큐 업로드.
async function startOnlineAction(attackerId, targetId, key) {
  const def = CARD_DEFS[key];
  if (TYPE_TIMING[def.type] !== 'MyTurn') { setStatus('아직 온라인 미지원입니다'); render(); return; }

  let queue;
  if (def.type === 'HEAL')      queue = buildHealQueue(attackerId, targetId, key);
  else if (def.type === 'ATK')  queue = buildAtkQueue(attackerId, targetId, key);
  else if (def.type === 'ALL')  queue = buildAllQueue(attackerId, key);   // Stage 3: 전체공격
  else { setStatus('아직 온라인 미지원입니다'); render(); return; }

  const ok = await claimAndUploadQueue(queue);
  if (!ok) { setStatus('지금은 행동할 수 없습니다'); render(); return; }
  // 재생은 리스너(onRoomData)가 seq 증가를 감지해 시작 (owner 포함 전원 동일 경로)
}

// 트랜잭션: 읽기-검증-쓰기 원자화. 내가 현재 AP가 아니거나 진행 중 액션 있으면 abort.
async function claimAndUploadQueue(queue) {
  const res = await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data) return;
    const order = toArr(data.turnOrder);
    if (order[data.currentTurnIndex || 0] !== S.myUid) return;          // 내 턴 아님 → abort
    if (data.action && data.action.done === false) return;            // 진행 중 → abort
    const seq = ((data.action && data.action.seq) || 0) + 1;
    // 내 손패는 이미 카드 사용분이 빠진 로컬 상태 → 권위 반영
    if (data.players[S.myUid]) data.players[S.myUid].hand = toArr(S.state.players[S.myUid].hand);
    data.action = { seq, queue, version:0, await:null, input:null, done:false, ownerUid:S.myUid };
    return data;
  });
  return res.committed;
}

function normalizeAction(act) {
  return {
    seq: act.seq, version: act.version || 0, done: act.done,
    queue: toArr(act.queue),
    await: act.await || null, input: act.input || null,
  };
}
function normalizeChoice(c) {
  if (c === 'take' || !c) return 'take';
  if (c.defCards) return { defCards: toArr(c.defCards) };
  return { k: c.k };
}

// owner: askDefense에서 await 게시 후 input 기다림
// owner 전용. timeoutMs 경과 시 자동 'take'(맞기)로 resolve → 게임 멈춤 방지(기획 6장).
function waitForInput(index, timeoutMs) {
  return new Promise(resolve => {
    const ref = db.ref('rooms/' + S.roomId + '/action/input');
    let done = false, timer = null;
    const finish = (val) => {
      if (done) return; done = true;
      ref.off('value', cb);
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    const cb = snap => {
      const inp = snap.val();
      if (inp && inp.index === index) finish(normalizeChoice(inp.choice));
    };
    ref.on('value', cb);
    if (timeoutMs) timer = setTimeout(() => finish('take'), timeoutMs);
  });
}
// spectator: owner가 큐에 반응 이벤트를 splice하고 resolved 표시할 때까지 대기 → 갱신된 큐 반환.
// action.done===true(=owner 이탈로 취소)면 'ABORT' 반환 → 재생 루프 탈출.
function waitForResolved(index) {
  return new Promise(resolve => {
    const ref = actionRef();
    const cb = snap => {
      const a = snap.val(); if (!a) return;
      if (a.done === true) { ref.off('value', cb); resolve('ABORT'); return; }
      const q = toArr(a.queue);
      if (q[index] && q[index].resolved) { ref.off('value', cb); resolve(q); }
    };
    ref.on('value', cb);
  });
}
// owner: 반응 이벤트 splice 후 큐 업로드 (resolved 플래그 포함), await/input 클리어
async function uploadActionQueue(q) {
  await actionRef().update({ queue:q, await:null, input:null });
}
// spectator(피격자): 모달 선택 결과를 input으로 기록 (트랜잭션 가드)
async function submitOnlineInput(index, choice) {
  await actionRef().transaction(a => {
    if (!a) return;
    if (!a.await || a.await.index !== index || a.await.target !== S.myUid) return; // 내 응답 차례 아님
    if (a.input) return;                                                          // 이미 제출됨
    a.input = { index, by: S.myUid, choice };
    return a;
  });
}

// 상설 리스너: action/await를 감시해 내가 응답자(target)면 모달 표시.
// 재생 루프와 분리 → owner가 target이어도(반사 역전 등) deadlock 없이 모달이 뜬다.
function watchAwait() {
  db.ref('rooms/' + S.roomId + '/action/await').on('value', snap => {
    const aw = snap.val();
    if (aw && aw.target === S.myUid) {
      if (S.awaitModalIndex === aw.index) return;   // 이미 이 index 반응 진행 중
      S.awaitModalIndex = aw.index;
      const reactions = getReactionCards(S.myUid, aw.aoe);   // DEF/REFLECT/Bounce 모두 허용
      startReaction(aw.attacker, S.myUid, aw.item, aw.incoming, reactions,
        choice => { S.awaitModalIndex = null; submitOnlineInput(aw.index, choice); }, true);
    } else {
      // await 해제(owner resolve/타임아웃) 또는 내 차례 아님 → 반응 UI 닫기
      if (S.awaitModalIndex !== null) { S.awaitModalIndex = null; cancelReaction(); }
    }
  });
}

export function startReactCountdown(sec) {
  stopReactCountdown();
  const el = document.getElementById('reactionTimer');
  let left = sec;
  const tick = () => {
    if (el) el.textContent = `⏳ ${left}초 내 미응답 시 자동 '맞기'`;
    if (left <= 0) { stopReactCountdown(); return; }
    left--;
  };
  tick();
  S.reactTimerInterval = setInterval(tick, 1000);
}
export function stopReactCountdown() {
  if (S.reactTimerInterval) { clearInterval(S.reactTimerInterval); S.reactTimerInterval = null; }
  const el = document.getElementById('reactionTimer');
  if (el) el.textContent = '';
}

// 온라인 재생기: 모든 클라가 동일 큐 재생. askDefense만 transport 분기.
async function playOnlineAction(act) {
  S.onlineReplaying = true;
  S.isPlaying = true;
  S.onlineLocalLogOnly = true;
  render();

  let q = act.queue.slice();
  let chainCount = 0;   // owner만 집행하는 연쇄 카운터 (안전 상한 20)
  const amOwner = () => S.myUid === S.state.turnOrder[S.state.currentTurnIndex];

  let i = 0;
  while (i < q.length) {
    const ev = q[i];

    if (ev.kind === 'askDefense' && !ev.resolved) {
      // 죽은 대상 skip (ALL build 이후 연쇄로 먼저 죽은 경우). owner/spectator 동일 판정 →
      // owner는 await 안 띄우고, spectator도 waitForResolved 없이 넘어가 lockstep 유지.
      if (!S.state.players[ev.target]?.alive) { i++; continue; }
      setQueueHighlight(ev.attacker, ev.target);

      if (amOwner()) {
        // 안전 상한: 연쇄 20회 초과 시 owner가 입력 안 받고 강제 맞기를 baking
        if (ev.chain && chainCount >= 20) {
          const forced = [
            { kind:'react', text:'⛔ 연쇄 종료!<br><small>강제 맞기</small>',
              log:'연쇄 상한(20) 도달 — 강제 맞기', logKind:'sys', stageCls:'miss' },
            { kind:'damage', target:ev.target, amount:ev.incoming, label:'연쇄 종료' }
          ];
          q.splice(i + 1, 0, ...forced);
          q[i] = { ...ev, resolved:true };
          await uploadActionQueue(q);
        } else {
          if (ev.chain) chainCount++;
          // owner: await 게시 → input 대기 → 반응 build(splice) → 업로드.
          // 모달 표시는 watchAwait(상설 리스너)가 담당 → owner가 target이어도 deadlock 없음.
          await actionRef().child('await').set({
            index:i, target:ev.target, attacker:ev.attacker, item:ev.item,
            incoming:ev.incoming, aoe:ev.aoe || false, chain:ev.chain || false
          });
          setStatus(`${S.state.players[ev.target]?.name || '?'}의 응답 대기...`);
          const choice = await waitForInput(i, RESPONSE_TIMEOUT);   // 30초 초과 시 자동 '맞기'
          const reactEvents = buildReactionEvents(ev.attacker, ev.target, ev.item, ev.incoming, choice, ev.aoe);
          q.splice(i + 1, 0, ...reactEvents);
          q[i] = { ...ev, resolved:true };
          await uploadActionQueue(q);
        }
      } else {
        // spectator: 모달은 watchAwait가 띄움. 여기선 owner의 resolve만 대기.
        setStatus(`${S.state.players[ev.target]?.name || '?'}의 응답 대기...`);
        const r = await waitForResolved(i);
        if (r === 'ABORT') break;   // owner 이탈로 action 취소됨 → 재생 중단
        q = r;
      }
      i++; continue;
    }

    await renderEventVisual(ev, q, i);
    i++;
  }

  // ── 행동 종료 ─────────────────────────────────────────────
  const wasOwner = amOwner();
  S.onlineReplaying = false;
  S.isPlaying = false;
  S.onlineLocalLogOnly = false;
  S.queueHighlight = { attacker:null, targeted:null };
  clearAllZones();

  if (wasOwner) {
    // owner 권위 정산: 손패 보충 + 턴 넘김 + 승패를 단일 원자적 write로 (중간 상태 없음)
    await commitSettlement();
    // 이후 자기 리스너가 최종 S.state로 idle 렌더
  } else {
    // spectator: 재생 중 놓친 DB 업데이트(특히 currentTurnIndex)를 다시 읽어 reconcile
    const fresh = (await db.ref('rooms/' + S.roomId).once('value')).val();
    if (fresh) onRoomData(fresh);
  }
}

// owner 권위 정산 (Stage 1~3): 손패 보충·턴 넘김·승패를 한 번의 update로 확정.
// 모든 클라는 이 DB값(currentTurnIndex/phase)만 보고 자기 턴 여부를 판정한다.
async function commitSettlement() {
  // 1) 손패 보충 (재생 중 적용된 HP/소모 위에 얹음)
  S.state.turnOrder.forEach(id => {
    const p = S.state.players[id];
    if (!p.alive) return;
    p.hand = toArr(p.hand);
    while (p.hand.length < CONFIG.maxHand) p.hand.push(drawCard());
  });
  // 2) 승패 / 다음 턴 계산
  const alive = S.state.turnOrder.filter(id => S.state.players[id].alive);
  let phase = 'playing', winner = null, voided = false, nextIdx = S.state.currentTurnIndex;
  if (alive.length <= 1) {
    phase = 'finished'; winner = alive[0] || null;
    if (alive.length === 0) { voided = true; pushLog('그리고 아무도 없었다.', 'sys'); }   // 전투 동시 전멸 → 무효
  } else {
    nextIdx = (S.state.currentTurnIndex + 1) % S.state.turnOrder.length;
    for (let t = 0; t < S.state.turnOrder.length; t++) {
      if (S.state.players[S.state.turnOrder[nextIdx]].alive) break;
      nextIdx = (nextIdx + 1) % S.state.turnOrder.length;
    }
  }
  // 3) 단일 원자적 write (players + currentTurnIndex + phase/winner/voided + action 종료)
  await db.ref('rooms/' + S.roomId).update({
    players: S.state.players,
    currentTurnIndex: nextIdx,
    phase, winner, voided,
    'action/done': true,
  });
}

// 온라인 패스: 트랜잭션으로 AP 검증 + 드로우 + 턴 넘김
export async function onlinePass() {
  await db.ref('rooms/' + S.roomId).transaction(data => {
    if (!data) return;
    const order = toArr(data.turnOrder);
    if (order[data.currentTurnIndex || 0] !== S.myUid) return;
    if (data.action && data.action.done === false) return;
    const p = data.players[S.myUid];
    p.hand = toArr(p.hand); p.hand.push(drawCard());
    const logArr = toArr(data.log);
    logArr.push(`${p.name}은 패스했다. (카드 1장 획득)`);
    data.log = logArr;
    let idx = (data.currentTurnIndex + 1) % order.length;
    for (let t = 0; t < order.length; t++) {
      if (data.players[order[idx]].alive) break;
      idx = (idx + 1) % order.length;
    }
    data.currentTurnIndex = idx;
    return data;
  });
}

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
