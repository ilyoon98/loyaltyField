// ── 온라인 전부 (Firebase 동기화 / owner 권위 액션 엔진 / presence 5c / 로비) ──
// 내부 호출이 많아 한 모듈로 응집(추출 안전). 외부 경계만 import.
import { S, myPlayerId } from './core/store.js';
import { db, FB_READY, ServerValue } from './core/firebase.js';
import { CARD_DEFS, TYPE_TIMING, CONFIG, RESPONSE_TIMEOUT, SKIP_GRACE, ABORT_GRACE, ELIM_GRACE, GHOST_GRACE, FIN_GRACE } from './data/cards.js';
import { CHARACTERS, charImgHtml } from './data/characters.js';
import { newHand, drawCard, toArr } from './util.js';
import { showScreen, setStatus, pushLog, appendLog, clearStage, clearAllZones } from './ui/render.js';
import { render, startReaction, cancelReaction } from './ui/input.js';
import { buildHealQueue, buildAtkQueue, buildAllQueue, renderEventVisual, buildReactionEvents, setQueueHighlight, getReactionCards } from './engine.js';

const actionRef = () => db.ref('rooms/' + S.roomId + '/action');

export async function createRoom() {
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

export function isGhostRoom(data, now) {
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

export async function sweepGhostRooms() {
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

export function updateJoinBtn() {
  const code = document.getElementById('roomCodeInput').value.trim();
  document.getElementById('joinRoomBtn').disabled = code.length !== 4;
}

export async function joinRoom() {
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

export function saveSession()  { sessionStorage.setItem('euri_room', S.roomId); sessionStorage.setItem('euri_name', S.myName); }

export function clearSession() { sessionStorage.removeItem('euri_room'); sessionStorage.removeItem('euri_name'); }

export async function tryRejoinOnline() {
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

export function setLobbyError(msg) { document.getElementById('lobbyError').textContent = msg; }

export function listenRoom() {
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

export function startPresence() {
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

export function watchPresence() {
  db.ref('rooms/' + S.roomId + '/presence').on('value', snap => {
    S.presenceMap = snap.val() || {};
    applyPresenceUI();
    checkAPRecovery();   // 5c-2: idle AP 끊김 → 턴 스킵
    checkOwnerAbort();   // 5c-3: 행동 중 owner 끊김 → action abort (재생 중에도 도는 경로)
    checkElimination();  // 5c-4: 끊김 30초 → 탈락 + 승패 재계산 + host 이양
  });
}

export function applyPresenceUI() {
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

export function amRecoveryAuthority() {
  if (S.gameMode !== 'online' || !S.state || !S.state.turnOrder) return false;
  for (const id of S.state.turnOrder) {
    const p = S.state.players[id];
    if (!p || !p.alive) continue;
    if (S.presenceMap[id] && S.presenceMap[id].connected === false) continue;
    return id === S.myUid;
  }
  return false;
}

export function checkAPRecovery() {
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

export async function skipDisconnectedAP(ap) {
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

export function checkOwnerAbort() {
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

export async function abortOwnerAction(owner) {
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

export function checkElimination() {
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

export async function eliminateDisconnected() {
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

export function renderWaitingRoom(data) {
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

export function copyRoomCode() {
  navigator.clipboard?.writeText(S.roomId).then(() => {
    const el = document.getElementById('roomCodeDisplay');
    const orig = el.textContent;
    el.textContent = '복사됨!';
    setTimeout(() => { el.textContent = orig; }, 1200);
  });
}

export async function startOnlineGame() {
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

export function syncStateFromData(data) {
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

export function onRoomData(data) {
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

export function classifyLog(msg) {
  if (msg.includes('탈락')) return 'sys';
  if (msg.includes('피해'))  return 'hit';
  if (msg.includes('회복'))  return 'heal';
  if (msg.includes('방어'))  return 'block';
  if (msg.includes('반사') || msg.includes('떠넘김')) return 'ref';
  if (msg.includes('빗나감')) return 'miss';
  return 'sys';
}

export function showWin() {
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

export async function leaveRoomAndReload() {
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

export function playAgain() {
  if (S.gameMode === 'online' && S.roomId && FB_READY) { rematchOnline(); return; }
  location.reload();
}

export async function rematchOnline() {
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

export async function startOnlineAction(attackerId, targetId, key) {
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

export async function claimAndUploadQueue(queue) {
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

export function normalizeAction(act) {
  return {
    seq: act.seq, version: act.version || 0, done: act.done,
    queue: toArr(act.queue),
    await: act.await || null, input: act.input || null,
  };
}

export function normalizeChoice(c) {
  if (c === 'take' || !c) return 'take';
  if (c.defCards) return { defCards: toArr(c.defCards) };
  return { k: c.k };
}

export function waitForInput(index, timeoutMs) {
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

export function waitForResolved(index) {
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

export async function uploadActionQueue(q) {
  await actionRef().update({ queue:q, await:null, input:null });
}

export async function submitOnlineInput(index, choice) {
  await actionRef().transaction(a => {
    if (!a) return;
    if (!a.await || a.await.index !== index || a.await.target !== S.myUid) return; // 내 응답 차례 아님
    if (a.input) return;                                                          // 이미 제출됨
    a.input = { index, by: S.myUid, choice };
    return a;
  });
}

export function watchAwait() {
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

export async function playOnlineAction(act) {
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

export async function commitSettlement() {
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
