// ── 카드·설정·상수 (불변 데이터) ──────────────────────────────
export const CARD_DEFS = {
  munchi:  { name:"뭉치 짖기",  type:"ALL",     value:10, prob:0.5, trigger:"최초", plusType:"ProbabilityUP", plusValue:0.25 },
  kalbang: { name:"칼빵",       type:"ATK",     value:5,  prob:1,   trigger:null,   plusType:null,            plusValue:0 },
  cook:    { name:"요리하기",   type:"HEAL",    value:5,  prob:1,   trigger:"종원", plusType:"ValueUP",       plusValue:2 },
  painkill:{ name:"진통제",     type:"DEF",     value:10, prob:1,   trigger:"기종", plusType:"ValueUP",       plusValue:5 },
  protein: { name:"프로틴",     type:"ATK",     value:5,  prob:1,   trigger:"현일", plusType:"HEAL",          plusValue:2 },
  mirror:  { name:"무지개 반사",type:"REFLECT", value:0,  prob:1,   trigger:null,   plusType:null,            plusValue:0 },
  bounce:  { name:"유수암쇄권", type:"Bounce",  value:0,  prob:1,   trigger:"기훈", plusType:"Target",        plusValue:2 },
};
export const CARD_KEYS = Object.keys(CARD_DEFS);
export const CARD_ICON = { munchi:'🐕', kalbang:'🔪', cook:'🍳', painkill:'💊', protein:'💪', mirror:'🌈', bounce:'🥋' };
export function cardIcon(k){ return CARD_ICON[k] || '🃏'; }

export const TYPE_TIMING = { ATK:"MyTurn", ALL:"MyTurn", HEAL:"MyTurn", DEF:"OnHit", REFLECT:"OnHit", Bounce:"OnHit" };
export const CONFIG = { startHp:50, maxHp:99, handSize:5, maxHand:6 };

export const RESPONSE_TIMEOUT = 30000;   // 피격 응답 제한시간(ms). 초과 시 owner가 자동 '맞기' 집행
export const SKIP_GRACE       = 5000;    // idle AP 끊김 후 턴 스킵까지 유예(ms). 5c-2.
export const ABORT_GRACE      = 0;       // owner 행동 중 끊김 → action abort 유예(ms). 5c-3. 0=즉시
export const ELIM_GRACE       = 30000;   // 끊김 후 탈락(alive=false)까지 유예(ms). 5c-4.
export const GHOST_GRACE      = 120000;  // 유령 방 정리 유예(ms). 전원 끊김 후 이 시간 지나면 삭제 대상.
export const FIN_GRACE        = 10000;   // finished 방은 더 짧은 유예 후 정리.

export const AI_IDS  = ["ai1","ai2","ai3"];
export const AI_NAMES = ["상대A","상대B","상대C"];
