// ── 플레이어 입력 + 손패/플레이어 렌더 + 피격 반응 UI ──────────
// render()/renderHand()는 onclick으로 입력 핸들러를 참조하므로 입력과 한 모듈.
// 엔진/온라인 함수(resolveMyTurnCard·nextTurn·onlinePass·start/stopReactCountdown)는
// 아직 main.js에 있어 임시 import (engine/online 추출 시 경로 교체). 런타임 순환이라 안전.
import { S, myPlayerId } from '../core/store.js';
import { CARD_DEFS, TYPE_TIMING, CONFIG, cardIcon, RESPONSE_TIMEOUT } from '../data/cards.js';
import { effValue } from '../data/characters.js';
import { toArr, drawCard } from '../util.js';
import { setStatus, pushLog } from './render.js';
import { resolveMyTurnCard, nextTurn, onlinePass, startReactCountdown, stopReactCountdown } from '../main.js';

// ── 카드 사용 ────────────────────────────────────────────────
export function useCard(handIdx) {
  if (S.isPlaying || S.onlineReplaying) return;
  const myId = myPlayerId();
  if (S.state.turnOrder[S.state.currentTurnIndex] !== myId) return;
  if (S.pendingCardUse) return;
  const me = S.state.players[myId];
  const key = me.hand[handIdx];
  const def = CARD_DEFS[key];
  if (TYPE_TIMING[def.type] !== 'MyTurn') { setStatus('이 카드는 공격받았을 때만 쓸 수 있어요'); return; }
  if (def.type === 'ATK') {
    S.pendingCardUse = { handIdx, key };
    setStatus('⚔ 공격할 상대를 클릭하세요  [취소: 패스 버튼]');
    render(); return;
  }
  if (def.type === 'HEAL') {
    S.pendingCardUse = { handIdx, key, heal:true };   // 자신 포함 회복 대상 선택
    setStatus('💚 회복할 대상을 클릭하세요 (자신 포함)  [취소: 패스 버튼]');
    render(); return;
  }
  me.hand.splice(handIdx, 1);
  resolveMyTurnCard(myId, null, key);
}

export function selectTarget(targetId) {
  if (S.isPlaying || S.onlineReplaying) return;
  if (!S.pendingCardUse) return;
  const myId = myPlayerId();
  if (!S.state.players[targetId].alive) return;
  if (!S.pendingCardUse.heal && targetId === myId) return;   // 공격은 자기 자신 불가, 회복은 허용
  const { handIdx, key } = S.pendingCardUse;
  S.pendingCardUse = null;
  S.state.players[myId].hand.splice(handIdx, 1);
  resolveMyTurnCard(myId, targetId, key);
}

export function cancelTargeting() {
  S.pendingCardUse = null;
  render();
  setStatus('내 턴 — 카드를 사용하거나 패스하세요');
}

// 패스 버튼 (main.js에서 passBtn.onclick으로 배선)
export function passAction() {
  if (S.isPlaying || S.onlineReplaying) return;
  const myId = myPlayerId();
  if (!S.state || S.state.turnOrder[S.state.currentTurnIndex] !== myId) return;
  if (S.pendingCardUse) { cancelTargeting(); return; }
  if (S.gameMode === 'online') { onlinePass(); return; }
  // 로컬
  S.state.players[myId].hand.push(drawCard());
  pushLog(`${S.state.players[myId].name}은 패스했다. (카드 1장 획득)`, 'sys');
  render();
  setTimeout(nextTurn, 500);
}

// ── 피격 반응 (손패 직접 클릭) ────────────────────────────────
// withCountdown: 온라인 응답에만 카운트다운(코스메틱). resolve는 choice 계약 그대로.
export function startReaction(attacker, target, atkKey, dmg, reactions, resolve, withCountdown) {
  S.reactionCtx = { attacker, target, atkKey, dmg, resolve, selectedDef: [] };
  document.getElementById('reactionBar').classList.add('active');
  document.getElementById('reactionInfo').innerHTML =
    `🛡 공격받음! ${S.state.players[attacker]?.name || '?'}의 ${CARD_DEFS[atkKey]?.name || '공격'} — <b>${dmg}</b> 데미지`;
  if (withCountdown) startReactCountdown(Math.floor(RESPONSE_TIMEOUT / 1000));
  else stopReactCountdown();
  updateReactionBar();
  renderHand();
  setStatus('손패에서 방어/반사/튕기기 카드를 누르거나 [그냥 맞기]');
}

export function updateReactionBar() {
  if (!S.reactionCtx) return;
  const me = S.state.players[S.reactionCtx.target];
  const tChar = me?.characterId;
  const total = S.reactionCtx.selectedDef.reduce((s, i) => s + effValue(toArr(me.hand)[i], tChar), 0);
  const sum = document.getElementById('reactionSummary');
  const confirm = document.getElementById('reactionConfirmBtn');
  if (S.reactionCtx.selectedDef.length > 0) {
    sum.textContent = `합산 방어 −${total} / 남은 데미지 ${Math.max(0, S.reactionCtx.dmg - total)}`;
    confirm.style.display = '';
  } else {
    sum.textContent = '방어 카드는 여러 장 눌러 누적할 수 있어요';
    confirm.style.display = 'none';
  }
}

// 손패 카드 클릭(반응 모드). DEF=누적 토글, REFLECT/Bounce=즉시 확정(방어와 혼용 불가).
export function handReactionClick(i) {
  if (!S.reactionCtx) return;
  const key = toArr(S.state.players[S.reactionCtx.target].hand)[i];
  const d = CARD_DEFS[key];
  if (!d || TYPE_TIMING[d.type] !== 'OnHit') return;
  if (d.type === 'DEF') {
    const pos = S.reactionCtx.selectedDef.indexOf(i);
    if (pos >= 0) S.reactionCtx.selectedDef.splice(pos, 1);
    else          S.reactionCtx.selectedDef.push(i);
    updateReactionBar(); renderHand();
  } else {
    if (S.reactionCtx.selectedDef.length > 0) { setStatus('방어와 반사/튕기기는 함께 쓸 수 없어요'); return; }
    resolveReaction({ k: key });
  }
}

export function reactionTake()    { if (S.reactionCtx) resolveReaction('take'); }
export function reactionConfirm() {
  if (!S.reactionCtx || S.reactionCtx.selectedDef.length === 0) return;
  const keys = S.reactionCtx.selectedDef.map(i => toArr(S.state.players[S.reactionCtx.target].hand)[i]);
  resolveReaction({ defCards: keys });
}

export function resolveReaction(choice) {
  if (!S.reactionCtx) return;
  const resolve = S.reactionCtx.resolve;
  S.reactionCtx = null;
  document.getElementById('reactionBar').classList.remove('active');
  stopReactCountdown();
  renderHand();
  resolve(choice);
}

// 내 입력 없이 상황 종료(온라인: owner 타임아웃/취소로 await 해제) → UI만 닫음(resolve 안 함)
export function cancelReaction() {
  if (!S.reactionCtx) return;
  S.reactionCtx = null;
  document.getElementById('reactionBar').classList.remove('active');
  stopReactCountdown();
  renderHand();
}

// ── 렌더링 (플레이어 카드 / 손패) ─────────────────────────────
export function render() {
  if (!S.state) return;
  const box  = document.getElementById('playersBox');
  box.innerHTML = '';
  const myId     = myPlayerId();
  const curId    = S.state.turnOrder[S.state.currentTurnIndex];
  const targeting = !!S.pendingCardUse;

  S.state.turnOrder.forEach(id => {
    const p = S.state.players[id];
    if (!p) return;
    const isTargetable = targeting && p.alive && (S.pendingCardUse.heal || id !== myId);
    let cls = 'pl';
    const isAct = S.isPlaying
      ? id === S.queueHighlight.attacker
      : (id === curId && p.alive);
    if (isAct) cls += ' active-turn';
    if (S.isPlaying && id === S.queueHighlight.targeted) cls += ' targeted';
    if (!p.alive) cls += ' dead';
    const off = S.presenceMap[id] && S.presenceMap[id].connected === false;   // 5c-1
    if (off) cls += ' disconnected';
    if (isTargetable) cls += ' targetable';
    const div = document.createElement('div');
    div.className = cls;
    div.id = 'pl-' + id;
    const nameCls = id === myId ? 'you' : 'ai';
    const hpPct = Math.max(0, p.hp / CONFIG.maxHp * 100);
    const hpCol = hpPct > 50 ? 'var(--green)' : hpPct > 25 ? 'var(--gold)' : 'var(--red)';
    div.innerHTML = `
      <div class="nm ${nameCls}">${p.name}${id===curId&&p.alive?' ◀':''}</div>
      <div class="char-tag">${p.characterId}${isTargetable?(S.pendingCardUse.heal?' 💚 클릭하여 회복':' 👆 클릭하여 타겟'):''}</div>
      <div class="hpbar"><div class="hpfill" style="width:${hpPct}%;background:linear-gradient(180deg,${hpCol},rgba(0,0,0,.3))"></div>
        <div class="hptext">${Math.max(0,p.hp)} / ${CONFIG.maxHp}</div></div>
      <div class="char-tag" style="margin-top:6px">손패 ${toArr(p.hand).length}장</div>
      ${off ? '<div class="disc-tag">🔌 연결 끊김</div>' : ''}`;
    if (isTargetable) div.onclick = () => selectTarget(id);
    box.appendChild(div);
  });
  renderHand();
}

export function renderHand() {
  const box  = document.getElementById('handBox');
  box.innerHTML = '';
  const myId = myPlayerId();
  const me   = S.state.players[myId];
  if (!me) return;
  const reacting = !!S.reactionCtx && S.reactionCtx.target === myId;   // 손패 직접 반응 모드
  const myTurn   = S.state.turnOrder[S.state.currentTurnIndex] === myId;
  const targeting = !!S.pendingCardUse;

  toArr(me.hand).forEach((k, i) => {
    const d = CARD_DEFS[k]; if (!d) return;
    const isMyTurnCard = TYPE_TIMING[d.type] === 'MyTurn';
    const isOnHit = TYPE_TIMING[d.type] === 'OnHit';
    const val = d.type==='HEAL'?`회복 ${d.value}`:d.type==='DEF'?`방어 ${d.value}`:d.type==='REFLECT'?'반사':d.type==='Bounce'?'떠넘김':`데미지 ${d.value}`;
    const prob = d.prob<1?` · 명중 ${Math.round(d.prob*100)}%`:'';
    const badge = d.trigger===me.characterId?`<div class="badge">전용</div>`:'';
    const inner = `${badge}<div class="ci">${cardIcon(k)}</div><div class="cn tag-${d.type}">${d.name}</div><div class="ct">${d.type} · ${val}${prob}</div><div class="ct" style="color:var(--muted)">${isMyTurnCard?'내 턴':'피격 시'}</div>`;
    const div = document.createElement('div');

    if (reacting) {
      // 반응 모드: OnHit 카드만 사용 가능. DEF는 누적(혼용 시 반사/튕기기 잠금).
      const selected = d.type==='DEF' && S.reactionCtx.selectedDef.includes(i);
      const blocked  = d.type!=='DEF' && S.reactionCtx.selectedDef.length > 0;  // 방어 선택 중 → 반사/튕기기 잠금
      const clickable = isOnHit && !blocked;
      div.className = 'card' + (clickable ? ' reactable' : ' disabled') + (selected ? ' react-selected' : '');
      div.innerHTML = inner;
      if (clickable) div.onclick = () => handReactionClick(i);
    } else {
      const usable  = myTurn && isMyTurnCard && !targeting && !S.isPlaying;
      const pending = targeting && S.pendingCardUse.handIdx === i;
      div.className = 'card' + (usable||pending?'':' disabled') + (pending?' active-turn':'');
      div.innerHTML = inner;
      if (usable) div.onclick = () => useCard(i);
    }
    box.appendChild(div);
  });
}
