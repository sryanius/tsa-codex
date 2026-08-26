/**
 * 침묵의 기록자 자료실 — Supabase 연결
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 용병단 게임의 `src/net/*` 을 가져다 쓰지 않고 따로 만들었다.
 * 두 프로젝트가 서로의 배포에 영향을 주지 않게 하려는 것이다 —
 * 같은 Supabase 프로젝트를 쓰지만 코드는 남남이다.
 *
 * ★ 여기 있는 두 값은 공개되는 것이 정상이다. 브라우저 코드에 그대로 실린다.
 *   방어선은 오직 RLS 와 비공개 버킷이다.
 *   · tsa-data (Storage) — 로그인한 사람만 읽는다
 *   · tsa_progress       — 본인 행만 읽고 쓴다
 *
 * ★ 클라우드가 죽어도 페이지는 떠야 한다. 데이터는 IndexedDB 에 캐시하고,
 *   네트워크가 없으면 캐시로 돈다. 이 계약이 깨지면 지하철에서 못 본다.
 */
(function () {
  "use strict";

  var URL_ = "https://peilvwrqgauwlaqojttq.supabase.co";
  var ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlaWx2d3JxZ2F1d2xhcW9qdHRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxNTU0MTEsImV4cCI6MjEwMjczMTQxMX0.ks353ZYcf79woaMNBCRLo4W5tRJgGiYyJKjMT3PS0pM";
  var SESSION_KEY = "tsa_session_v1";
  var VERIFIER_KEY = "tsa_pkce_v1";
  var DB_NAME = "tsa-cache";

  /* ── 저장 헬퍼 ─────────────────────────────────────────────────────── */
  function ls(k, v) {
    try {
      if (v === undefined) { var s = localStorage.getItem(k); return s ? JSON.parse(s) : null; }
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v));
    } catch (e) { }
    return null;
  }

  /* ── IndexedDB 캐시 (2MB 넘는 데이터라 localStorage 로는 부족하다) ──── */
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function cacheGet(k) {
    try {
      var db = await idb();
      return await new Promise(function (res) {
        var t = db.transaction("kv").objectStore("kv").get(k);
        t.onsuccess = function () { res(t.result || null); };
        t.onerror = function () { res(null); };
      });
    } catch (e) { return null; }
  }
  async function cachePut(k, v) {
    try {
      var db = await idb();
      await new Promise(function (res) {
        var t = db.transaction("kv", "readwrite").objectStore("kv").put(v, k);
        t.onsuccess = t.onerror = function () { res(); };
      });
    } catch (e) { }
  }

  /* ── PKCE ──────────────────────────────────────────────────────────── */
  function b64url(buf) {
    var s = btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
    return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function makeVerifier() {
    var a = new Uint8Array(64); crypto.getRandomValues(a);
    return b64url(a.buffer);
  }
  async function challengeOf(v) {
    return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  }
  function selfUrl() {
    var u = new URL(location.href); u.search = ""; u.hash = ""; return u.toString();
  }

  /* ── 세션 ──────────────────────────────────────────────────────────── */
  function session() { return ls(SESSION_KEY); }
  function saveSession(j) {
    if (!j || !j.access_token) return null;
    var s = {
      access: j.access_token, refresh: j.refresh_token || "",
      exp: Date.now() + (j.expires_in || 3600) * 1000,
      email: (j.user && j.user.email) || "",
      userId: (j.user && j.user.id) || ""
    };
    ls(SESSION_KEY, s); return s;
  }

  async function api(path, opt) {
    opt = opt || {};
    var s = session();
    var h = { apikey: ANON, "Content-Type": "application/json" };
    if (opt.auth !== false && s) h.Authorization = "Bearer " + s.access;
    if (opt.headers) for (var k in opt.headers) h[k] = opt.headers[k];
    var r = await fetch(URL_ + path, {
      method: opt.method || "GET", headers: h,
      body: opt.body ? JSON.stringify(opt.body) : undefined
    });
    return r;
  }

  async function refresh() {
    var s = session();
    if (!s || !s.refresh) return null;
    var r = await api("/auth/v1/token?grant_type=refresh_token", {
      method: "POST", auth: false, body: { refresh_token: s.refresh }
    });
    if (!r.ok) { ls(SESSION_KEY, null); return null; }
    return saveSession(await r.json());
  }
  async function ensureFresh() {
    var s = session();
    if (!s) return null;
    if (s.exp - Date.now() > 60000) return s;
    return await refresh();
  }

  window.TSA_CLOUD = {
    enabled: true,
    session: session,
    signedIn: function () { return !!session(); },
    email: function () { var s = session(); return s ? s.email : ""; },

    /** 구글 로그인 시작. 페이지를 떠난다. */
    signIn: async function (selectAccount) {
      var v = makeVerifier();
      ls(VERIFIER_KEY, v);
      var u = new URL(URL_ + "/auth/v1/authorize");
      u.searchParams.set("provider", "google");
      u.searchParams.set("redirect_to", selfUrl());
      u.searchParams.set("code_challenge", await challengeOf(v));
      u.searchParams.set("code_challenge_method", "s256");
      if (selectAccount) u.searchParams.set("prompt", "select_account");
      location.assign(u.toString());
    },

    signOut: function () { ls(SESSION_KEY, null); ls(VERIFIER_KEY, null); },

    /** 로그인에서 돌아왔으면 코드를 토큰으로 바꾼다. 부팅 때 한 번 부른다. */
    completeOAuth: async function () {
      var url = new URL(location.href);
      var code = url.searchParams.get("code");
      var err = url.searchParams.get("error_description") || url.searchParams.get("error");
      var clean = function () {
        try {
          var u = new URL(location.href); u.search = ""; u.hash = "";
          history.replaceState(null, "", u.toString());
        } catch (e) { }
      };
      if (err) { clean(); return { ok: false, error: err }; }
      if (!code) return { ok: false, error: "", none: true };
      var v = ls(VERIFIER_KEY);
      clean();
      if (!v) return { ok: false, error: "로그인 정보를 잃었습니다. 다시 시도해 주세요." };
      var r = await api("/auth/v1/token?grant_type=pkce", {
        method: "POST", auth: false, body: { auth_code: code, code_verifier: v }
      });
      ls(VERIFIER_KEY, null);
      if (!r.ok) {
        var j = await r.json().catch(function () { return {}; });
        var stale = j.error_code === "flow_state_not_found" || r.status === 404;
        return { ok: false, error: stale ? "로그인이 만료됐습니다. 다시 눌러 주세요." : (j.msg || j.error_description || "로그인 실패") };
      }
      saveSession(await r.json());
      return { ok: true, error: "" };
    },

    /**
     * 게임 데이터를 받는다. 캐시가 있으면 먼저 쓰고 뒤에서 갱신한다.
     * @param {string} name  'data.json' | 'codex.json'
     */
    fetchData: async function (name, onCached) {
      var cached = await cacheGet(name);
      if (cached && onCached) { try { onCached(cached); } catch (e) { } }
      var s = await ensureFresh();
      if (!s) return cached;                       // 로그인 없으면 캐시가 전부다
      try {
        var r = await fetch(URL_ + "/storage/v1/object/tsa-data/" + name, {
          headers: { apikey: ANON, Authorization: "Bearer " + s.access }
        });
        if (!r.ok) return cached;
        var j = await r.json();
        await cachePut(name, j);
        return j;
      } catch (e) { return cached; }
    },

    /**
     * 저장된 상태 받기.
     * payload 에는 세이브에서 뽑은 진행도(q)뿐 아니라
     * 손으로 넣은 값(시설 레벨·남은 의뢰·슬롯 수·수동 체크)도 함께 들어 있다.
     * 기기를 옮겨도 화면이 똑같이 보여야 하므로 한 덩어리로 다룬다.
     */
    getProgress: async function () {
      var s = await ensureFresh();
      // 조용히 null 을 돌려주면 «저장된 게 없다» 로 읽힌다.
      // 로그인이 끊긴 것과 아직 올린 적이 없는 것은 다른 사건이므로 갈라 놓는다.
      if (!s) throw new Error("로그인이 끊겼습니다. 다시 로그인해 주세요.");
      var r = await api("/rest/v1/tsa_progress?select=payload,saved_at&user_id=eq." + s.userId);
      if (!r.ok) throw new Error(r.status + " " + (await r.text().catch(function () { return ""; })).slice(0, 120));
      var rows = await r.json();
      if (!rows.length) return null;
      try {
        var p = JSON.parse(rows[0].payload);
        // 옛 형식(퀘스트 맵만 저장)도 읽어 준다
        if (p && !p.q && typeof p === "object") p = { q: p };
        p.at = rows[0].saved_at;
        return p;
      } catch (e) { return null; }
    },

    /** 상태 올리기 (upsert) */
    putProgress: async function (state) {
      var s = await ensureFresh();
      if (!s) return { ok: false, error: "로그인이 필요합니다" };
      var q = (state && state.q) || {};
      var cleared = 0, recorded = 0;
      for (var k in q) { recorded++; if (q[k].clear > 0) cleared++; }
      var now = new Date().toISOString();
      var body = {
        user_id: s.userId,
        payload: JSON.stringify({
          q: q,
          at: state.at || "",
          levels: state.levels || {},
          remain: state.remain || {},
          slots: state.slots || null,
          done: state.done || {}
        }),
        saved_at: now, cleared: cleared, recorded: recorded, updated_at: now
      };
      var r = await api("/rest/v1/tsa_progress", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: [body]
      });
      if (!r.ok) {
        var t = "";
        try { t = (await r.text()).slice(0, 160); } catch (e) { }
        return { ok: false, error: r.status + " " + t };
      }
      return { ok: true, cleared: cleared, recorded: recorded };
    }
  };
})();
