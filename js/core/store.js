// ── 공유 런타임 상태 (단일 인스턴스) ─────────────────────────
// import 바인딩은 읽기전용이라 재할당 불가 → 가변 전역을 객체 S의 속성으로 모아 공유.
// 모듈들은 S를 import해 S.state 등으로 읽고 쓴다(속성 변경은 모듈 경계를 넘어 공유됨).
function initUid() {
  let id = sessionStorage.getItem('euri_uid');
  if (!id) { id = 'u_' + Math.random().toString(36).substr(2, 8); sessionStorage.setItem('euri_uid', id); }
  return id;
}
export const S = {
  // 공통
  gameMode: 'local', state: null, selectedChar: null, pendingCardUse: null, isPlaying: false,
  // 온라인 식별/방
  myUid: initUid(), myName: '', roomId: null, isHost: false, roomRef: null, prevLogLen: 0,
  // 온라인 액션/재생
  onlineSeq: 0, onlineReplaying: false, onlineLocalLogOnly: false,
  awaitWatchStarted: false, awaitModalIndex: null, reactionCtx: null,
  // presence (5c)
  presenceMap: {}, presenceStarted: false,
  apRecoveryTimer: null, ownerAbortTimer: null, elimTimer: null,
  // 연출/오디오/치트
  queueHighlight: { attacker: null, targeted: null },
  reactTimerInterval: null, audioCtx: null,
  cheatVisible: false, titleClicks: 0, titleClickTimer: null,
};
