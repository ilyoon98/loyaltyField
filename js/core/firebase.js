// ── Firebase 단일 인스턴스 ────────────────────────────────────
// 전역 `firebase`(compat CDN, index.html에서 모듈보다 먼저 로드)를 사용.
// db·FB_READY를 여기서 한 번만 만들어 다른 모듈이 import해 공유한다 (구독·init 단일화).
//
// Firebase 콘솔 → Realtime Database(테스트 모드) → 웹앱 추가 → 아래 값 교체.
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCJNIEKNrlBVHaw3msQDc9wl5jkPh1srAs",
  authDomain:        "loyalty-super-melee.firebaseapp.com",
  databaseURL:       "https://loyalty-super-melee-default-rtdb.firebaseio.com",
  projectId:         "loyalty-super-melee",
  storageBucket:     "loyalty-super-melee.firebasestorage.app",
  messagingSenderId: "752015537678",
  appId:             "1:752015537678:web:b8c02f26b7d5edb0e4ee5f"
};

export const FB_READY = FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";

let _db = null;
if (FB_READY) {
  firebase.initializeApp(FIREBASE_CONFIG);
  _db = firebase.database();
}
export const db = _db;
export const ServerValue = FB_READY ? firebase.database.ServerValue : null;
