// ── 이벤트 큐 + 재생 엔진 + 게임 로직 (로컬·온라인 공용) ──────
// 큐 생성/재생, 반응 이벤트, 데미지, 턴 흐름, AI, 승패. renderEventVisual은
// 온라인 playOnlineAction도 호출(동일 큐 lockstep 재생). 동작 보존.
import { S, myPlayerId } from './core/store.js';
import { CARD_DEFS, TYPE_TIMING, CONFIG, AI_IDS, AI_NAMES, cardIcon } from './data/cards.js';
import { CHARACTERS, effProb, effValue } from './data/characters.js';
import { drawCard, newHand, rollHit, toArr, sleep } from './util.js';
import { showScreen, setStatus, showStageLeft, showStageCenter, showStageRight,
         clearCenterRight, clearAllZones, clearStage, floatNumber, vfxAt, playSFX, pushLog } from './ui/render.js';
import { render, renderHand, startReaction } from './ui/input.js';
import { startOnlineAction, showWin } from './main.js';   // 임시(online 추출 시 경로 교체)

export function startLocalGame() {
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

export function beginTurn() {
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

export function getReactionCards(playerId, aoe) {
  return toArr(S.state.players[playerId].hand)
    .map((k,i) => ({k,i}))
    .filter(o => TYPE_TIMING[CARD_DEFS[o.k]?.type] === 'OnHit');
}

export function applyDamage(targetId, dmg, sourceId, label) {
  const p = S.state.players[targetId];
  if (!p.alive) return;
  p.hp -= dmg;
  pushLog(`${p.name} ${label}으로 ${dmg} 피해 (HP ${Math.max(0,p.hp)})`, 'hit');
  if (p.hp <= 0) { p.hp = 0; p.alive = false; pushLog(`💀 ${p.name} 탈락!`, 'sys'); }
}

export function setQueueHighlight(attacker, targeted) {
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

export function buildHealQueue(actorId, healTarget, key) {
  const ch = S.state.players[actorId].characterId;
  const tgt = healTarget || actorId;
  return [{ kind:'selfheal', actor:actorId, target:tgt, amount:effValue(key, ch), card:key }];
}

export function buildAtkQueue(attackerId, targetId, key) {
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

export function buildAllQueue(attackerId, key) {
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

export function buildReactionEvents(attackerId, targetId, atkKey, dmg, choice, aoe) {
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

export function askDefense(attackerId, targetId, atkKey, dmg, aoe) {
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

export async function renderEventVisual(ev, q, i) {
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

export async function playQueue(q, onDone) {
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

export function aiTurn() {
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

export function checkWin() {
  const alive = S.state.turnOrder.filter(id => S.state.players[id].alive);
  if (alive.length <= 1) {
    S.state.phase = 'finished'; S.state.winner = alive[0] || null;
    S.state.voided = (alive.length === 0);   // 5c-4: 동시 전멸 무효
    if (S.state.voided) pushLog('그리고 아무도 없었다.', 'sys');
    showWin(); return true;
  }
  return false;
}
